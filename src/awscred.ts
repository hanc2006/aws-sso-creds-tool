import { homedir, hostname } from "os";
import { readFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { parseJSON } from "confbox";
import { exists } from "./util";

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

/**
 * AwsCred class encapsulates configuration loading and credential file path management
 */
export default class AwsCred {
  private readonly _config: ConfigSchema;

  private constructor(config: ConfigSchema) {
    this._config = config;
  }

  /**
   * Creates an AwsCred instance by loading configuration from the config file
   * Performs async file operations to load or create the config
   */
  public static async load(): Promise<AwsCred> {
    const config = await AwsCred.loadConfig();

    if (!config.ssoUrl || config.ssoUrl === "https://<your-project>.awsapps.com/start#/") {
      throw new Error(
        "Please set the SSO URL in ~/.config/auto-aws-sso-creds/config.json"
      );
    }

    return new AwsCred(config);
  }

  /**
   * Load configuration from file, similar to conf package behavior
   */
  private static async loadConfig(): Promise<ConfigSchema> {
    const configDir = join(homedir(), ".config", "auto-aws-sso-creds");
    const configPath = join(configDir, "config.json");

    if (await exists(configPath)) {
      try {
        const fileContent = await readFile(configPath, "utf-8");
        const parsed = parseJSON<Partial<ConfigSchema>>(fileContent);
        return { ...defaults, ...parsed };
      } catch {
        // If parsing fails, create config with defaults
        return AwsCred.createDefaultConfig(configDir, configPath);
      }
    }

    return AwsCred.createDefaultConfig(configDir, configPath);
  }

  /**
   * Create default configuration file
   */
  private static async createDefaultConfig(configDir: string, configPath: string): Promise<ConfigSchema> {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(defaults, null, 2));
    return defaults;
  }

  /**
   * Gets the SSO start URL
   */
  public get startUrl(): string {
    return this._config.ssoUrl;
  }

  /**
   * Gets the AWS credentials file path
   */
  public get awsCredentialsPath(): string {
    return this._config.awsCredentialsPath ?? `${homedir()}/.aws/credentials`;
  }

  /**
   * Gets whether to use account ID in section names
   */
  public get useAccountId(): boolean {
    return this._config.useAccountId;
  }

  /**
   * Gets the list of SSO accounts
   */
  public get ssoAccounts(): string[] {
    return this._config.accounts
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s) ?? [];
  }

  /**
   * Gets the AWS region
   */
  public get region(): string {
    return this._config.region ?? "us-east-1";
  }

  /**
   * Gets the client name (hostname)
   */
  public get clientName(): string {
    return hostname();
  }

  /**
   * Gets the default section name
   */
  public get defaultSection(): string {
    return this._config.defaultSection ?? "ViewOnlyAccess";
  }
}

export { AwsCred };
