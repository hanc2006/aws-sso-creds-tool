import chalk from 'chalk'
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
import open from 'open'

export interface LoginSession {
  accessToken: string
  expiresAt?: number
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

/**
 * AwsSso class encapsulates the SSO session and credential fetching logic
 */
export default class AwsSso {
  private readonly _session: LoginSession
  private readonly _region: string
  private readonly _clientSso: SSOClient

  constructor(session: LoginSession, region: string) {
    this._session = session
    this._region = region
    this._clientSso = new SSOClient({ region })
  }

  /**
   * Creates an AwsSso instance from SSO start URL and region
   * Performs the full SSO login flow including device authorization
   */
  public static async fromStartUrl(
    startUrl: string,
    region: string,
    clientName: string,
    forceLogin: boolean = false
  ): Promise<AwsSso> {
    if (!startUrl.startsWith('https://')) {
      throw new Error('startUrl must be a valid https url')
    }

    const session = await AwsSso.login(startUrl, region, clientName)
    return new AwsSso(session, region)
  }

  /**
   * Performs the SSO login flow
   */
  private static async login(
    startUrl: string,
    region: string,
    clientName: string
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
    const accessToken = await AwsSso.pollForAccessToken(
      clientDevice,
      clientId,
      clientSecret,
      deviceCode,
      userCode
    )

    return { accessToken }
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
  ): Promise<string> {
    const createTokenCommand = new CreateTokenCommand({
      clientId,
      clientSecret,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      deviceCode,
      code: userCode,
    })

    try {
      const response = await clientDevice.send(createTokenCommand)
      if (!response.accessToken) {
        throw new Error('Failed to get access token: missing accessToken')
      }
      return response.accessToken
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
      expiration: response.roleCredentials.expiration,
      region: this._region,
    }
    return result
  }

  /**
   * Logs an error message with formatting
   */
  public logError(message: string, accountId: string, roleName: string): void {
    console.error(
      `${chalk.red(message)} for account ${chalk.green(accountId)}, role: ${chalk.green(roleName)}`
    )
  }
}

export { AwsSso }
