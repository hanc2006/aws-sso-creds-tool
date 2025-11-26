#!/usr/bin/env node

import { writeFile, readFile } from "fs/promises";
import { homedir } from "os";
import { parseINI, stringifyINI } from "confbox";
import { AwsSso } from "./awssso";
import { AwsCred } from "./awscred";
import { exists } from "./util";

interface CredentialsSection {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
}

interface CredentialsFile {
  [section: string]: CredentialsSection;
}

const updateCredentials = async (): Promise<void> => {
  // Load AWS config using AwsCred class
  const awsCred = await AwsCred.load();

  // Get SSO session info
  const session = awsCred.getSession();
  if (!session) {
    throw new Error("No SSO session found in AWS config");
  }

  // Load existing credentials file
  const credentialsPath = `${homedir()}/.aws/credentials`;
  let credentialsFile: CredentialsFile = {};
  
  if (await exists(credentialsPath)) {
    try {
      const fileContent = await readFile(credentialsPath, "utf-8");
      credentialsFile = parseINI(fileContent) as CredentialsFile;
    } catch (e) {
      console.error(`Warning: Could not load credentials file: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  // Create AwsSso instance and perform authentication flow
  const awsSso = new AwsSso({ 
    region: session.ssoRegion, 
    startUrl: session.ssoStartUrl 
  });
  await awsSso.login();

  // Get all profiles from AWS config
  const profiles = awsCred.getProfiles();

  for (const [profileName, profile] of Object.entries(profiles)) {
    try {
      // Use AwsSso.getCredentials method to get credentials for each profile
      const roleCredentials = await awsSso.getCredentials(
        profile.ssoAccountId, 
        profile.ssoRoleName
      );

      const { accessKeyId, secretAccessKey, sessionToken } = roleCredentials;

      if (!accessKeyId || !secretAccessKey || !sessionToken) {
        console.error(`Missing credentials for profile ${profileName}`);
        continue;
      }

      // Update credentials for this profile
      if (!credentialsFile[profileName]) {
        credentialsFile[profileName] = {};
      }
      credentialsFile[profileName].aws_access_key_id = accessKeyId;
      credentialsFile[profileName].aws_secret_access_key = secretAccessKey;
      credentialsFile[profileName].aws_session_token = sessionToken;
      
      console.log(`Updated credentials for profile: ${profileName}`);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`${e.message} for profile ${profileName}`);
      } else {
        console.error(`Error fetching credentials for profile ${profileName}`);
      }
    }
  }

  // Save credentials file
  try {
    await writeFile(credentialsPath, stringifyINI(credentialsFile));
    console.log("credentials updated");
  } catch (e) {
    throw new Error(`Failed to save credentials: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }
};

updateCredentials();
