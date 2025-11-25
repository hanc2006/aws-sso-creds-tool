import open from "open";

import { startUrl, region, clientName } from "./params";

import {
  SSOClient,
  ListAccountsCommand,
  ListAccountRolesCommand,
  GetRoleCredentialsCommand,
  AccountInfo,
  RoleInfo,
  RoleCredentials,
} from "@aws-sdk/client-sso";
import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
} from "@aws-sdk/client-sso-oidc";

const clientSso = new SSOClient({ region });
const clientDevice = new SSOOIDCClient({ region });

export interface RegisterClientResult {
  clientId: string;
  clientSecret: string;
}

export interface AuthorizeDeviceResult {
  deviceCode: string;
  userCode: string;
}

export interface AccessTokenResult {
  accessToken: string;
}

export interface AccountsResult {
  accountList: AccountInfo[];
}

export interface AccountRolesResult {
  roleList: RoleInfo[];
}

export async function registerClient(): Promise<RegisterClientResult> {
  const registerClientCommand = new RegisterClientCommand({
    clientName,
    clientType: "public",
  });
  const response = await clientDevice.send(registerClientCommand);

  if (!response.clientId || !response.clientSecret) {
    throw new Error("Failed to register client: missing clientId or clientSecret");
  }

  return {
    clientId: response.clientId,
    clientSecret: response.clientSecret,
  };
}

export async function authorizeDevice(
  clientId: string,
  clientSecret: string
): Promise<AuthorizeDeviceResult> {
  const startDeviceAuthorizationCommand = new StartDeviceAuthorizationCommand({
    clientId,
    clientSecret,
    startUrl,
  });
  const { verificationUri, deviceCode, userCode } = await clientDevice.send(
    startDeviceAuthorizationCommand
  );

  if (!verificationUri || !deviceCode || !userCode) {
    throw new Error("Failed to authorize device: missing required fields");
  }

  await open(`${verificationUri}?user_code=${userCode}`);
  console.info("Waiting for login, to cancel press CTRL+C");

  return {
    deviceCode,
    userCode,
  };
}

export async function getAccessToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  userCode: string
): Promise<AccessTokenResult> {
  const createTokenCommand = new CreateTokenCommand({
    clientId,
    clientSecret,
    grantType: "urn:ietf:params:oauth:grant-type:device_code",
    deviceCode,
    code: userCode,
  });
  const response = await clientDevice.send(createTokenCommand);

  if (!response.accessToken) {
    throw new Error("Failed to get access token: missing accessToken");
  }

  return {
    accessToken: response.accessToken,
  };
}

export async function getAccounts(accessToken: string): Promise<AccountsResult> {
  const listAccountsCommand = new ListAccountsCommand({
    accessToken,
  });
  const response = await clientSso.send(listAccountsCommand);

  return {
    accountList: response.accountList ?? [],
  };
}

export async function getAccountRoles(
  accessToken: string,
  accountId: string
): Promise<AccountRolesResult> {
  const listAccountRolesCommand = new ListAccountRolesCommand({
    accessToken,
    accountId,
  });
  const response = await clientSso.send(listAccountRolesCommand);

  return {
    roleList: response.roleList ?? [],
  };
}

export async function getAccountRoleCredentials(
  accessToken: string,
  accountId: string,
  roleName: string
): Promise<RoleCredentials> {
  const getRoleCredentialsCommand = new GetRoleCredentialsCommand({
    accessToken,
    accountId,
    roleName,
  });
  const { roleCredentials } = await clientSso.send(getRoleCredentialsCommand);

  if (!roleCredentials) {
    throw new Error("Failed to get role credentials");
  }

  return roleCredentials;
}
