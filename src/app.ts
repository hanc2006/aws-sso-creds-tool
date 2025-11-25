#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  awsCredentialsPath,
  useAccountId,
  defaultSection,
  sso_accounts,
  startUrl,
  region,
  clientName,
} from "./params.js";
import { parseINI, stringifyINI } from "confbox";
import { AwsSso } from "./awssso.js";
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

  // Create AwsSso instance which handles the full authentication flow
  const awsSso = await AwsSso.fromStartUrl(startUrl, region, clientName);

  // Get all accounts available to the authenticated user
  const { accountList } = await awsSso.getAccounts();

  for (const { accountId, accountName } of accountList) {
    if (!accountId || !accountName) {
      continue;
    }

    // Get roles for each account using the AwsSso instance
    const { roleList } = await awsSso.getAccountRoles(accountId);

    for (const { roleName } of roleList) {
      if (!roleName) {
        continue;
      }

      if (sso_accounts.includes(accountName)) {
        try {
          // Use AwsSso.getCredentials method instead of getAccountRoleCredentials
          const roleCredentials = await awsSso.getCredentials(accountId, roleName);

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
        } catch (e) {
          if (e instanceof Error) {
            console.error(`${e.message} for account ${accountId}, role: ${roleName}`);
          } else {
            console.error(`Error fetching credentials for ${accountName}_${roleName}`);
          }
        }
      }
    }
  }

  // saves changes into credentials file
  writeFileSync(awsCredentialsPath, stringifyINI(config));
  console.log("credentials updated");
};

updateCredentials();
