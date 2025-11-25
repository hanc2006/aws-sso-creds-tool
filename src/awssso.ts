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

export interface LoginSession {
  accessToken: string
  expiresAt?: number
  profileName?: string
}

export interface TokenExpiredEventData {
  profileName?: string
  expiresAt?: number
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

interface AuthorizationError extends Error {
  name: string
}

export interface AwsSsoOptions {
  autoRefresh?: boolean
  region?: string
  startUrl?: string
  clientName?: string
  profileName?: string
}

interface TokenResult {
  accessToken: string
  expiresAt?: number
}

/**
 * AwsSso class encapsulates the SSO session and credential fetching logic
 * Extends EventEmitter to emit token expiration events
 */
export default class AwsSso extends EventEmitter {
  private _session: LoginSession | null = null
  private _region: string | null = null
  private _clientSso: SSOClient | null = null
  private readonly _autoRefresh: boolean
  private _abortController: AbortController | null = null
  private _startUrl: string | null = null
  private _clientName: string | null = null
  private _profileName: string | undefined

  constructor(options?: AwsSsoOptions) {
    super()
    this._autoRefresh = options?.autoRefresh ?? false
    this._region = options?.region ?? null
    this._startUrl = options?.startUrl ?? null
    this._clientName = options?.clientName ?? null
    this._profileName = options?.profileName
    if (this._region) {
      this._clientSso = new SSOClient({ region: this._region })
    }
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
      const now = Date.now()
      const timeUntilExpiry = this._session.expiresAt - now

      if (timeUntilExpiry <= 0) {
        // Token already expired
        this._handleTokenExpiration()
      } else {
        // Set timer with a maximum limit to prevent excessively long timeouts
        const timeout = Math.min(timeUntilExpiry, AwsSso.MAX_TIMEOUT_MS)
        this._abortController = new AbortController()
        const signal = this._abortController.signal

        setTimeoutPromise(timeout, undefined, { signal })
          .then(() => {
            // If we hit the max timeout but token hasn't expired yet, re-check
            if (this._session?.expiresAt && Date.now() < this._session.expiresAt) {
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

    if (this._autoRefresh && this._startUrl && this._clientName && this._region) {
      this._refreshSession().catch((error) => {
        this.emit('tokenRefreshError', { error, profileName: this._session?.profileName })
      })
    } else if (this._autoRefresh && (!this._startUrl || !this._clientName || !this._region)) {
      this.emit('tokenRefreshError', {
        error: new Error('Cannot auto-refresh: missing startUrl, clientName, or region. Use fromStartUrl() to enable auto-refresh.'),
        profileName: this._session?.profileName,
      })
    }
  }

  /**
   * Refreshes the session token
   */
  private async _refreshSession(): Promise<void> {
    if (!this._startUrl || !this._clientName || !this._region) {
      throw new Error('Cannot refresh session: missing startUrl, clientName, or region')
    }

    try {
      const profileName = this._session?.profileName
      await this.login(this._startUrl, this._region, this._clientName, profileName)
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
   * Performs the SSO login flow and stores session in the instance
   * @param startUrl - The AWS SSO start URL
   * @param region - The AWS region
   * @param clientName - The client name for registration
   * @param profileName - Optional profile name to associate with the session
   */
  public async fromStartUrl(
    startUrl: string,
    region: string,
    clientName: string,
    profileName?: string
  ): Promise<void> {
    if (!startUrl.startsWith('https://')) {
      throw new Error('startUrl must be a valid https url')
    }

    this._startUrl = startUrl
    this._region = region
    this._clientName = clientName
    this._clientSso = new SSOClient({ region })

    await this.login(startUrl, region, clientName, profileName)
  }

  /**
   * Performs the SSO login flow and stores the session
   * @param startUrl - The AWS SSO start URL
   * @param region - The AWS region
   * @param clientName - The client name for registration
   * @param profileName - Optional profile name to associate with the session
   */
  public async login(
    startUrl: string,
    region: string,
    clientName: string,
    profileName?: string
  ): Promise<void> {
    const clientDevice = new SSOOIDCClient({ region })

    // Register client
    const registerClientCommand = new RegisterClientCommand({
      clientName,
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
      startUrl,
    })
    const deviceAuthResponse = await clientDevice.send(startDeviceAuthorizationCommand)

    if (!deviceAuthResponse.verificationUri || !deviceAuthResponse.deviceCode || !deviceAuthResponse.userCode) {
      throw new Error('Failed to authorize device: missing required fields')
    }

    const { verificationUri, deviceCode, userCode } = deviceAuthResponse

    await open(`${verificationUri}?user_code=${userCode}`)
    console.info('Waiting for login, to cancel press CTRL+C')

    // Poll for access token
    const tokenResult = await this.pollForAccessToken(
      clientDevice,
      clientId,
      clientSecret,
      deviceCode,
      userCode
    )

    // Store session in the instance
    const session: LoginSession = {
      accessToken: tokenResult.accessToken,
    }

    if (tokenResult.expiresAt !== undefined) {
      session.expiresAt = tokenResult.expiresAt
    }
    if (profileName !== undefined) {
      session.profileName = profileName
    }

    this._session = session
    this._startExpirationCheck()
  }

  /**
   * Polls for access token until authorization is complete
   */
  private async pollForAccessToken(
    clientDevice: SSOOIDCClient,
    clientId: string,
    clientSecret: string,
    deviceCode: string,
    userCode: string
  ): Promise<TokenResult> {
    const createTokenCommand = new CreateTokenCommand({
      clientId,
      clientSecret,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      deviceCode,
      // AWS SDK uses 'code' parameter which takes the userCode value
      code: userCode,
    })

    try {
      const response = await clientDevice.send(createTokenCommand)
      if (!response.accessToken) {
        throw new Error('Failed to get access token: missing accessToken')
      }
      // Calculate expiresAt from expiresIn (in seconds) if available
      const result: TokenResult = { accessToken: response.accessToken }
      if (response.expiresIn) {
        result.expiresAt = Date.now() + response.expiresIn * 1000
      }
      return result
    } catch (err) {
      const authError = err as AuthorizationError
      if (authError.name === 'AuthorizationPendingException') {
        return new Promise((resolve) => {
          setTimeout(
            () =>
              this.pollForAccessToken(clientDevice, clientId, clientSecret, deviceCode, userCode).then(
                resolve
              ),
            1000
          )
        })
      }
      console.error(err)
      throw err
    }
  }

  /**
   * Gets the access token from the current session
   */
  public get accessToken(): string {
    if (!this._session) {
      throw new Error('No active session. Call fromStartUrl() or login() first.')
    }
    return this._session.accessToken
  }

  /**
   * Gets the region for the SSO client
   */
  public get region(): string {
    if (!this._region) {
      throw new Error('No region configured. Call fromStartUrl() or login() first.')
    }
    return this._region
  }

  /**
   * Gets the profile name from the current session
   */
  public get profileName(): string | undefined {
    return this._session?.profileName
  }

  /**
   * Gets the expiration time from the current session
   */
  public get expiresAt(): number | undefined {
    return this._session?.expiresAt
  }

  /**
   * Checks if the session token is expired
   */
  public isExpired(): boolean {
    if (!this._session?.expiresAt) {
      return false
    }
    return Date.now() >= this._session.expiresAt
  }

  /**
   * Lists all accounts available to the authenticated user
   */
  public async getAccounts(): Promise<AccountsResult> {
    if (!this._session || !this._clientSso) {
      throw new Error('No active session. Call fromStartUrl() or login() first.')
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
    if (!this._session || !this._clientSso) {
      throw new Error('No active session. Call fromStartUrl() or login() first.')
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
    if (!this._session || !this._clientSso || !this._region) {
      throw new Error('No active session. Call fromStartUrl() or login() first.')
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
      region: this._region,
    }
    if (response.roleCredentials.expiration !== undefined) {
      result.expiration = response.roleCredentials.expiration
    }
    return result
  }
}

export { AwsSso }
