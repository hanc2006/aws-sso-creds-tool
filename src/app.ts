#!/usr/bin/env node

import {
  awsCredentialsPath,
  useAccountId,
  defaultSection,
  sso_accounts,
} from "./params.js";
import ConfigParser from "configparser";
import type { CreateTokenCommandOutput } from "@aws-sdk/client-sso-oidc";
import {
  getAccountRoleCredentials,
  getAccountRoles,
  getAccounts,
  getAccessToken,
  authorizeDevice,
  registerClient,
} from "./aws.js";
import { error as throwError } from "./util.js";
const config = new ConfigParser();

async function pollForAccessToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  userCode: string
): Promise<CreateTokenCommandOutput> {
  return getAccessToken(clientId, clientSecret, deviceCode, userCode).catch(
    (error: Error & { name: string }) => {
      if (error.name === "AuthorizationPendingException") {
        return new Promise<CreateTokenCommandOutput>((resolve) => {
          setTimeout(
            () =>
              pollForAccessToken(
                clientId,
                clientSecret,
                deviceCode,
                userCode
              ).then(resolve),
            1000
          );
        });
      }
      console.error(error);
      throw error;
    }
  );
}

const updateCredentials = async () => {
  // search for credentials file first, default: ~/.aws/credentials
  try {
    await config.readAsync(awsCredentialsPath as string);
  } catch (e) {
    throwError("cannot open file: " + awsCredentialsPath);
  }

  // start authentication flow
  const { clientId, clientSecret } = await registerClient();
  
  if (!clientId || !clientSecret) {
    throwError("Failed to register client");
  }
  
  // needs to the user to be fully logged in
  const { deviceCode, userCode } = await authorizeDevice(
    clientId,
    clientSecret
  );

  if (!deviceCode || !userCode) {
    throwError("Failed to authorize device");
  }

  // const { accessToken } = await getAccessToken(clientId, clientSecret, deviceCode, userCode);
  const { accessToken } = await pollForAccessToken(
    clientId,
    clientSecret,
    deviceCode,
    userCode
  );
  
  if (!accessToken) {
    throwError("Failed to get access token");
  }
  
  const { accountList } = await getAccounts(accessToken);

  if (!accountList) {
    throwError("Failed to get account list");
  }

  for (const { accountId, accountName } of accountList) {
    if (!accountId) continue;
    
    const { roleList } = await getAccountRoles(accessToken, accountId);

    if (!roleList) continue;

    for (const { roleName } of roleList) {
      if (!roleName || !accountName) continue;
      
      if (sso_accounts.includes(accountName)) {
        const roleCredentials = await getAccountRoleCredentials(accessToken, accountId, roleName);
        
        if (!roleCredentials) continue;
        
        const { accessKeyId, secretAccessKey, sessionToken } = roleCredentials;

        if (!accessKeyId || !secretAccessKey || !sessionToken) continue;

        // default format is [account-name_AWSRoleName]
        const account_section_name = useAccountId
          ? accountId + "_" + roleName
          : accountName + "_" + roleName;
        !config.sections().includes(account_section_name)
          ? config.addSection(account_section_name)
          : "";
        config.set(account_section_name, "aws_access_key_id", accessKeyId);
        config.set(
          account_section_name,
          "aws_secret_access_key",
          secretAccessKey
        );
        config.set(account_section_name, "aws_session_token", sessionToken);
        console.log(config.items(account_section_name));

        if (account_section_name === defaultSection) {
          const default_section = "default";
          !config.sections().includes(default_section)
            ? config.addSection(default_section)
            : "";

          config.set(default_section, "aws_access_key_id", accessKeyId);
          config.set(default_section, "aws_secret_access_key", secretAccessKey);
          config.set(default_section, "aws_session_token", sessionToken);
        }
      }
    }
  }

  // saves changes into credentials file
  config.write(awsCredentialsPath as string);
  console.log("credentials updated");
};

updateCredentials();
