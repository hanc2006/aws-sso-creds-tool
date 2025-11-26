import {
  SSOClient,
  GetRoleCredentialsCommand,
  ListAccountsCommand,
  ListAccountRolesCommand,
  RoleCredentials,
  AccountInfo,
  RoleInfo,
} from '@aws-sdk/client-sso'
import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
} from '@aws-sdk/client-sso-oidc'
import { EventEmitter } from 'events'
import { setTimeout as setTimeoutPromise } from 'node:timers/promises'
import open from 'open'
import { isExpired, expiresInToUTCString } from './date'

export interface LoginSession {
  accessToken: string
  expiresAt?: string
  profileName?: string
}

export interface TokenExpiredEventData {
  profileName?: string
  expiresAt?: string
  expiredAt: number
}

export interface RoleCredential extends RoleCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiration?: number
  region: string
}

export interface AccountsResult {
  accountList: AccountInfo[]
}

export interface AccountRolesResult {
  roleList: RoleInfo[]
}

export interface AwsSsoOptions {
  autoRefresh?: boolean
  region: string
  startUrl: string
  profileName?: string
}

/**
 * AwsSso class encapsulates the SSO session and credential fetching logic
 * Extends EventEmitter to emit token expiration events
 * Implements Disposable pattern for resource cleanup
 */
export default class AwsSso extends EventEmitter implements Disposable {
  /**
   * Static identifier for this class
   */
  public static readonly id = 'aws-sso-creds-tool'

  private _session: LoginSession | null = null
  private _clientSso: SSOClient
  private _abortController: AbortController | null = null
  private _options: AwsSsoOptions

  constructor(options: AwsSsoOptions) {
    super()
    this._options = options
    this._clientSso = new SSOClient({ region: options.region })
  }

  /**
   * Disposes of resources used by this instance
   * Implements the Disposable pattern
   */
  [Symbol.dispose](): void {
    this.stopExpirationCheck()
    this._session = null
  }

  /**
   * Maximum timeout in milliseconds (24 hours) for expiration check timer.
   * This prevents issues with very long timeouts and ensures periodic re-checks.
   */
  private static readonly MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

  /**
   * Starts the expiration check using promise-based timer with AbortController
   */
  private _startExpirationCheck(): void {
    // Abort any existing timer
    if (this._abortController) {
      this._abortController.abort()
      this._abortController = null
    }

    if (this._session?.expiresAt) {
      if (isExpired(this._session.expiresAt)) {
        // Token already expired
        this._handleTokenExpiration()
      } else {
        // Calculate time until expiry
        const expiresAtDate = new Date(this._session.expiresAt.replace('Z', '+00:00'))
        const timeUntilExpiry = expiresAtDate.getTime() - Date.now()
        // Set timer with a maximum limit to prevent excessively long timeouts
        const timeout = Math.min(timeUntilExpiry, AwsSso.MAX_TIMEOUT_MS)
        this._abortController = new AbortController()
        const signal = this._abortController.signal

        setTimeoutPromise(timeout, undefined, { signal })
          .then(() => {
            // If we hit the max timeout but token hasn't expired yet, re-check
            if (this._session?.expiresAt && !isExpired(this._session.expiresAt)) {
              this._startExpirationCheck()
            } else {
              this._handleTokenExpiration()
            }
          })
          .catch((err: Error) => {
            if (err.name === 'AbortError') {
              // Timer was aborted, this is expected behavior
              return
            }
            console.error('Expiration check error:', err)
          })
      }
    }
  }

  /**
   * Handles token expiration by emitting event and optionally refreshing
   */
  private _handleTokenExpiration(): void {
    const eventData: TokenExpiredEventData = {
      expiredAt: Date.now(),
    }

    if (this._session?.profileName !== undefined) {
      eventData.profileName = this._session.profileName
    }
    if (this._session?.expiresAt !== undefined) {
      eventData.expiresAt = this._session.expiresAt
    }

    this.emit('tokenExpired', eventData)

    if (this._options.autoRefresh) {
      this._refreshSession().catch((error) => {
        this.emit('tokenRefreshError', { error, profileName: this._session?.profileName })
      })
    }
  }

  /**
   * Refreshes the session token
   */
  private async _refreshSession(): Promise<void> {
    try {
      const profileName = this._session?.profileName
      await this.login(profileName)
      this.emit('tokenRefreshed', { profileName: this._session?.profileName })
    } catch (error) {
      this.emit('tokenRefreshError', { error, profileName: this._session?.profileName })
      throw error
    }
  }

  /**
   * Stops the expiration check timer
   */
  public stopExpirationCheck(): void {
    if (this._abortController) {
      this._abortController.abort()
      this._abortController = null
    }
  }

  /**
   * Performs the SSO login flow and stores the session
   * @param profileName - Optional profile name to associate with the session
   */
  public async login(profileName?: string): Promise<void> {
    if (!this._options.startUrl.startsWith('https://')) {
      throw new Error('startUrl must be a valid https url')
    }

    const clientDevice = new SSOOIDCClient({ region: this._options.region })

    // Register client
    const registerClientCommand = new RegisterClientCommand({
      clientName: AwsSso.id,
      clientType: 'public',
    })
    const registerResponse = await clientDevice.send(registerClientCommand)

    if (!registerResponse.clientId || !registerResponse.clientSecret) {
      throw new Error('Failed to register client: missing clientId or clientSecret')
    }

    const { clientId, clientSecret } = registerResponse

    // Start device authorization
    const startDeviceAuthorizationCommand = new StartDeviceAuthorizationCommand({
      clientId,
      clientSecret,
      startUrl: this._options.startUrl,
    })
    const deviceAuthResponse = await clientDevice.send(startDeviceAuthorizationCommand)

    if (!deviceAuthResponse.verificationUri || !deviceAuthResponse.deviceCode || !deviceAuthResponse.userCode) {
      throw new Error('Failed to authorize device: missing required fields')
    }

    const { verificationUri, deviceCode, userCode } = deviceAuthResponse

    await open(`${verificationUri}?user_code=${userCode}`)
    console.info('Waiting for login, to cancel press CTRL+C')

    // Create token
    const createTokenCommand = new CreateTokenCommand({
      clientId,
      clientSecret,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      deviceCode,
      code: userCode,
    })
    const tokenResponse = await clientDevice.send(createTokenCommand)

    if (!tokenResponse.accessToken) {
      throw new Error('Failed to get access token: missing accessToken')
    }

    // Store session in the instance
    const session: LoginSession = {
      accessToken: tokenResponse.accessToken,
    }

    if (tokenResponse.expiresIn) {
      session.expiresAt = expiresInToUTCString(tokenResponse.expiresIn)
    }
    if (profileName !== undefined) {
      session.profileName = profileName
    }

    this._session = session
    this._startExpirationCheck()
  }

  /**
   * Gets the access token from the current session
   */
  public get accessToken(): string {
    if (!this._session) {
      throw new Error('No active session. Call login() first.')
    }
    return this._session.accessToken
  }

  /**
   * Gets the region for the SSO client
   */
  public get region(): string {
    return this._options.region
  }

  /**
   * Gets the profile name from the current session
   */
  public get profileName(): string | undefined {
    return this._session?.profileName
  }

  /**
   * Gets the expiration time from the current session as UTC string
   */
  public get expiresAt(): string | undefined {
    return this._session?.expiresAt
  }

  /**
   * Checks if the session token is expired
   */
  public isExpired(): boolean {
    if (!this._session?.expiresAt) {
      return false
    }
    return isExpired(this._session.expiresAt)
  }

  /**
   * Lists all accounts available to the authenticated user
   */
  public async getAccounts(): Promise<AccountsResult> {
    if (!this._session) {
      throw new Error('No active session. Call login() first.')
    }
    const listAccountsCommand = new ListAccountsCommand({
      accessToken: this._session.accessToken,
    })
    const response = await this._clientSso.send(listAccountsCommand)

    return {
      accountList: response.accountList ?? [],
    }
  }

  /**
   * Lists all roles for a specific account
   */
  public async getAccountRoles(accountId: string): Promise<AccountRolesResult> {
    if (!this._session) {
      throw new Error('No active session. Call login() first.')
    }
    const listAccountRolesCommand = new ListAccountRolesCommand({
      accessToken: this._session.accessToken,
      accountId,
    })
    const response = await this._clientSso.send(listAccountRolesCommand)

    return {
      roleList: response.roleList ?? [],
    }
  }

  /**
   * Gets credentials for a specific account and role
   */
  public async getCredentials(accountId: string, roleName: string): Promise<RoleCredential> {
    if (!this._session) {
      throw new Error('No active session. Call login() first.')
    }
    const getRoleCredentialsCommand = new GetRoleCredentialsCommand({
      accessToken: this._session.accessToken,
      accountId,
      roleName,
    })
    const response = await this._clientSso.send(getRoleCredentialsCommand)

    if (
      response.roleCredentials?.accessKeyId == null ||
      response.roleCredentials?.secretAccessKey == null ||
      response.roleCredentials?.sessionToken == null
    ) {
      throw new Error('Unable to fetch role credentials with AWS SDK')
    }

    const result: RoleCredential = {
      accessKeyId: response.roleCredentials.accessKeyId,
      secretAccessKey: response.roleCredentials.secretAccessKey,
      sessionToken: response.roleCredentials.sessionToken,
      region: this._options.region,
    }
    if (response.roleCredentials.expiration !== undefined) {
      result.expiration = response.roleCredentials.expiration
    }
    return result
  }
}

export { AwsSso }
