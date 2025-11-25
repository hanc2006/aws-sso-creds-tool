#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  awsCredentialsPath,
  useAccountId,
  defaultSection,
  sso_accounts,
} from "./params.js";
import { parseINI, stringifyINI } from "confbox";
import {
  getAccountRoleCredentials,
  getAccountRoles,
  getAccounts,
  getAccessToken,
  authorizeDevice,
  registerClient,
  AccessTokenResult,
} from "./aws.js";
import { error } from "./util.js";

interface CredentialsSection {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
}

interface CredentialsConfig {
  [section: string]: CredentialsSection;
}

let config: CredentialsConfig = {};

interface AuthorizationError extends Error {
  name: string;
}

async function pollForAccessToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  userCode: string
): Promise<AccessTokenResult> {
  try {
    return await getAccessToken(clientId, clientSecret, deviceCode, userCode);
  } catch (err) {
    const authError = err as AuthorizationError;
    if (authError.name === "AuthorizationPendingException") {
      return new Promise((resolve) => {
        setTimeout(
          () =>
            pollForAccessToken(clientId, clientSecret, deviceCode, userCode).then(
              resolve
            ),
          1000
        );
      });
    }
    console.error(err);
    throw err;
  }
}

const updateCredentials = async (): Promise<void> => {
  // search for credentials file first, default: ~/.aws/credentials
  try {
    if (existsSync(awsCredentialsPath)) {
      const fileContent = readFileSync(awsCredentialsPath, "utf-8");
      config = parseINI(fileContent) as CredentialsConfig;
    }
  } catch (e) {
    error("cannot open file: " + awsCredentialsPath);
  }

  // start authentication flow
  const { clientId, clientSecret } = await registerClient();
  // waits for the user to be fully logged in
  const { deviceCode, userCode } = await authorizeDevice(clientId, clientSecret);

  const { accessToken } = await pollForAccessToken(
    clientId,
    clientSecret,
    deviceCode,
    userCode
  );
  const { accountList } = await getAccounts(accessToken);

  for (const { accountId, accountName } of accountList) {
    if (!accountId || !accountName) {
      continue;
    }

    const { roleList } = await getAccountRoles(accessToken, accountId);

    for (const { roleName } of roleList) {
      if (!roleName) {
        continue;
      }

      if (sso_accounts.includes(accountName)) {
        const roleCredentials = await getAccountRoleCredentials(
          accessToken,
          accountId,
          roleName
        );

        const { accessKeyId, secretAccessKey, sessionToken } = roleCredentials;

        if (!accessKeyId || !secretAccessKey || !sessionToken) {
          console.error(`Missing credentials for ${accountName}_${roleName}`);
          continue;
        }

        // default format is [account-name_AWSRoleName]
        const account_section_name = useAccountId
          ? `${accountId}_${roleName}`
          : `${accountName}_${roleName}`;

        if (!config[account_section_name]) {
          config[account_section_name] = {};
        }

        config[account_section_name].aws_access_key_id = accessKeyId;
        config[account_section_name].aws_secret_access_key = secretAccessKey;
        config[account_section_name].aws_session_token = sessionToken;
        console.log(config[account_section_name]);

        if (account_section_name === defaultSection) {
          const default_section = "default";
          if (!config[default_section]) {
            config[default_section] = {};
          }

          config[default_section].aws_access_key_id = accessKeyId;
          config[default_section].aws_secret_access_key = secretAccessKey;
          config[default_section].aws_session_token = sessionToken;
        }
      }
    }
  }

  // saves changes into credentials file
  writeFileSync(awsCredentialsPath, stringifyINI(config));
  console.log("credentials updated");
};

updateCredentials();
