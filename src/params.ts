import { homedir, hostname } from "os";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseJSON } from "confbox";

interface ConfigSchema {
  region: string;
  ssoUrl: string;
  useAccountId: boolean;
  defaultSection: string;
  accounts: string;
  awsCredentialsPath?: string;
}

const defaults: ConfigSchema = {
  region: "us-east-1",
  ssoUrl: "https://<your-project>.awsapps.com/start#/",
  useAccountId: true,
  defaultSection: "<account-id>_<role-name>",
  accounts: "account1, account2, account3",
};

// Load configuration from file, similar to conf package behavior
function loadConfig(): ConfigSchema {
  const configDir = join(homedir(), ".config", "auto-aws-sso-creds");
  const configPath = join(configDir, "config.json");

  if (existsSync(configPath)) {
    try {
      const fileContent = readFileSync(configPath, "utf-8");
      const parsed = parseJSON<Partial<ConfigSchema>>(fileContent);
      return { ...defaults, ...parsed };
    } catch {
      // If parsing fails, create config with defaults
      return createDefaultConfig(configDir, configPath);
    }
  }

  return createDefaultConfig(configDir, configPath);
}

function createDefaultConfig(configDir: string, configPath: string): ConfigSchema {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(defaults, null, 2));
  return defaults;
}

const config = loadConfig();

const ssoUrl = config.ssoUrl;
if (!ssoUrl || ssoUrl === "https://<your-project>.awsapps.com/start#/") {
  throw new Error(
    "Please set the SSO URL in ~/.config/auto-aws-sso-creds/config.json"
  );
}

export const startUrl: string = ssoUrl;
export const awsCredentialsPath: string =
  config.awsCredentialsPath ?? `${homedir()}/.aws/credentials`;
export const useAccountId: boolean = config.useAccountId;
export const sso_accounts: string[] = config.accounts
  ?.split(",")
  .map((s) => s.trim())
  .filter((s) => s) ?? [];
export const region: string = config.region ?? "us-east-1";
export const clientName: string = hostname();
export const defaultSection: string =
  config.defaultSection ?? "ViewOnlyAccess";
