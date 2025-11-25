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
  private _session: LoginSession
  private readonly _region: string
  private readonly _clientSso: SSOClient
  private readonly _autoRefresh: boolean
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null
  private _startUrl: string | null = null
  private _clientName: string | null = null

  constructor(session: LoginSession, region: string, options?: AwsSsoOptions) {
    super()
    this._session = session
    this._region = region
    this._clientSso = new SSOClient({ region })
    this._autoRefresh = options?.autoRefresh ?? false
    this._startExpirationCheck()
  }

  /**
   * Starts the expiration check timer if expiresAt is set
   */
  private _startExpirationCheck(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer)
      this._refreshTimer = null
    }

    if (this._session.expiresAt) {
      const now = Date.now()
      const timeUntilExpiry = this._session.expiresAt - now

      if (timeUntilExpiry <= 0) {
        // Token already expired
        this._handleTokenExpiration()
      } else {
        // Set timer to fire when token expires
        this._refreshTimer = setTimeout(() => {
          this._handleTokenExpiration()
        }, timeUntilExpiry)
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

    if (this._session.profileName !== undefined) {
      eventData.profileName = this._session.profileName
    }
    if (this._session.expiresAt !== undefined) {
      eventData.expiresAt = this._session.expiresAt
    }

    this.emit('tokenExpired', eventData)

    if (this._autoRefresh && this._startUrl && this._clientName) {
      this._refreshSession()
    }
  }

  /**
   * Refreshes the session token
   */
  private async _refreshSession(): Promise<void> {
    if (!this._startUrl || !this._clientName) {
      return
    }

    try {
      const profileName = this._session.profileName
      const newSession = await AwsSso.login(this._startUrl, this._region, this._clientName, profileName)
      this._session = newSession
      this._startExpirationCheck()
      this.emit('tokenRefreshed', { profileName: this._session.profileName })
    } catch (error) {
      this.emit('tokenRefreshError', { error, profileName: this._session.profileName })
    }
  }

  /**
   * Stops the expiration check timer
   */
  public stopExpirationCheck(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer)
      this._refreshTimer = null
    }
  }

  /**
   * Creates an AwsSso instance from SSO start URL and region
   * Performs the full SSO login flow including device authorization
   * @param startUrl - The AWS SSO start URL
   * @param region - The AWS region
   * @param clientName - The client name for registration
   * @param options - Optional configuration including autoRefresh
   * @param profileName - Optional profile name to associate with the session
   */
  public static async fromStartUrl(
    startUrl: string,
    region: string,
    clientName: string,
    options?: AwsSsoOptions,
    profileName?: string
  ): Promise<AwsSso> {
    if (!startUrl.startsWith('https://')) {
      throw new Error('startUrl must be a valid https url')
    }

    const session = await AwsSso.login(startUrl, region, clientName, profileName)
    const instance = new AwsSso(session, region, options)
    instance._startUrl = startUrl
    instance._clientName = clientName
    return instance
  }

  /**
   * Performs the SSO login flow
   * @param profileName - Optional profile name to associate with the session
   */
  private static async login(
    startUrl: string,
    region: string,
    clientName: string,
    profileName?: string
  ): Promise<LoginSession> {
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
    const tokenResult = await AwsSso.pollForAccessToken(
      clientDevice,
      clientId,
      clientSecret,
      deviceCode,
      userCode
    )

    const session: LoginSession = {
      accessToken: tokenResult.accessToken,
    }

    if (tokenResult.expiresAt !== undefined) {
      session.expiresAt = tokenResult.expiresAt
    }
    if (profileName !== undefined) {
      session.profileName = profileName
    }

    return session
  }

  /**
   * Polls for access token until authorization is complete
   */
  private static async pollForAccessToken(
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
              AwsSso.pollForAccessToken(clientDevice, clientId, clientSecret, deviceCode, userCode).then(
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
    return this._session.accessToken
  }

  /**
   * Gets the region for the SSO client
   */
  public get region(): string {
    return this._region
  }

  /**
   * Gets the profile name from the current session
   */
  public get profileName(): string | undefined {
    return this._session.profileName
  }

  /**
   * Gets the expiration time from the current session
   */
  public get expiresAt(): number | undefined {
    return this._session.expiresAt
  }

  /**
   * Checks if the session token is expired
   */
  public isExpired(): boolean {
    if (!this._session.expiresAt) {
      return false
    }
    return Date.now() >= this._session.expiresAt
  }

  /**
   * Lists all accounts available to the authenticated user
   */
  public async getAccounts(): Promise<AccountsResult> {
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
