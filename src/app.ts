#!/usr/bin/env node

import { AwsSso } from "./awssso";
import { AwsCred } from "./awscred";

const updateCredentials = async (): Promise<void> => {
  // Load configuration using AwsCred class
  const awsCred = await AwsCred.load();

  // Load existing credentials
  await awsCred.loadCredentials();

  // Create AwsSso instance and perform authentication flow
  const awsSso = new AwsSso({ region: awsCred.region, startUrl: awsCred.startUrl });
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

          awsCred.setCredentials(account_section_name, accessKeyId, secretAccessKey, sessionToken);
          console.log(`Updated credentials for ${account_section_name}`);

          if (account_section_name === awsCred.defaultSection) {
            awsCred.setCredentials("default", accessKeyId, secretAccessKey, sessionToken);
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
  await awsCred.saveCredentials();
  console.log("credentials updated");
};

updateCredentials();
