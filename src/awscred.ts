import { homedir, hostname } from "os";
import { readFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { parseJSON, parseINI, stringifyINI } from "confbox";
import { exists } from "./util";

interface CredentialsSection {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
}

interface CredentialsConfig {
  [section: string]: CredentialsSection;
}

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
  private _credentials: CredentialsConfig = {};

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

  /**
   * Load credentials from the AWS credentials file
   */
  public async loadCredentials(): Promise<void> {
    if (await exists(this.awsCredentialsPath)) {
      try {
        const fileContent = await readFile(this.awsCredentialsPath, "utf-8");
        this._credentials = parseINI(fileContent) as CredentialsConfig;
      } catch (e) {
        console.error(`Warning: Could not load credentials file: ${e instanceof Error ? e.message : 'Unknown error'}`);
        this._credentials = {};
      }
    }
  }

  /**
   * Set credentials for a specific section
   */
  public setCredentials(
    sectionName: string,
    accessKeyId: string,
    secretAccessKey: string,
    sessionToken: string
  ): void {
    if (!this._credentials[sectionName]) {
      this._credentials[sectionName] = {};
    }
    this._credentials[sectionName].aws_access_key_id = accessKeyId;
    this._credentials[sectionName].aws_secret_access_key = secretAccessKey;
    this._credentials[sectionName].aws_session_token = sessionToken;
  }

  /**
   * Save credentials to the AWS credentials file
   */
  public async saveCredentials(): Promise<void> {
    try {
      await writeFile(this.awsCredentialsPath, stringifyINI(this._credentials));
    } catch (e) {
      throw new Error(`Failed to save credentials to ${this.awsCredentialsPath}: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }
}

export { AwsCred };
