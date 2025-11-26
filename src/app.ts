#!/usr/bin/env node

import { readFile, writeFile } from "fs/promises";
import { parseINI, stringifyINI } from "confbox";
import { AwsSso } from "./awssso";
import { AwsCred } from "./awscred";
import { error, exists } from "./util";

interface CredentialsSection {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
}

interface CredentialsConfig {
  [section: string]: CredentialsSection;
}

const updateCredentials = async (): Promise<void> => {
  // Load configuration using AwsCred class
  const awsCred = await AwsCred.load();
  
  let config: CredentialsConfig = {};

  // search for credentials file first, default: ~/.aws/credentials
  try {
    if (await exists(awsCred.awsCredentialsPath)) {
      const fileContent = await readFile(awsCred.awsCredentialsPath, "utf-8");
      config = parseINI(fileContent) as CredentialsConfig;
    }
  } catch (e) {
    error("cannot open file: " + awsCred.awsCredentialsPath);
  }

  // Create AwsSso instance and perform authentication flow
  const awsSso = new AwsSso({ region, startUrl });
  await awsSso.login();

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

      if (awsCred.ssoAccounts.includes(accountName)) {
        try {
          // Use AwsSso.getCredentials method instead of getAccountRoleCredentials
          const roleCredentials = await awsSso.getCredentials(accountId, roleName);

          const { accessKeyId, secretAccessKey, sessionToken } = roleCredentials;

          if (!accessKeyId || !secretAccessKey || !sessionToken) {
            console.error(`Missing credentials for ${accountName}_${roleName}`);
            continue;
          }

          // default format is [account-name_AWSRoleName]
          const account_section_name = awsCred.useAccountId
            ? `${accountId}_${roleName}`
            : `${accountName}_${roleName}`;

          if (!config[account_section_name]) {
            config[account_section_name] = {};
          }

          config[account_section_name].aws_access_key_id = accessKeyId;
          config[account_section_name].aws_secret_access_key = secretAccessKey;
          config[account_section_name].aws_session_token = sessionToken;
          console.log(config[account_section_name]);

          if (account_section_name === awsCred.defaultSection) {
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
  await writeFile(awsCred.awsCredentialsPath, stringifyINI(config));
  console.log("credentials updated");
};

updateCredentials();
