import { homedir, hostname } from "os";
import { readFile } from "fs/promises";
import { parseINI } from "confbox";
import { exists } from "./util";

/**
 * Represents the SSO session configuration from ~/.aws/config
 */
export interface CredentialsConfigSession {
  ssoStartUrl: string;
  ssoRegion: string;
  ssoRegistrationScopes: string;
}

/**
 * Represents a profile configuration from ~/.aws/config
 */
export interface CredentialsConfigProfile {
  region: string;
  ssoSession: string;
  ssoAccountId: string;
  ssoRoleName: string;
}

/**
 * Represents the full AWS config file structure
 */
export interface CredentialsConfig {
  session: {
    [name: string]: CredentialsConfigSession;
  };
  profile: {
    [name: string]: CredentialsConfigProfile;
  };
}

/**
 * Raw INI section as parsed from the config file
 */
interface RawIniSection {
  sso_start_url?: string;
  sso_region?: string;
  sso_registration_scopes?: string;
  region?: string;
  sso_session?: string;
  sso_account_id?: string;
  sso_role_name?: string;
  [key: string]: string | undefined;
}

/**
 * Raw INI config as parsed from file
 */
interface RawIniConfig {
  [section: string]: RawIniSection;
}

/**
 * AwsCred class encapsulates loading and parsing the AWS config file (~/.aws/config)
 */
export default class AwsCred {
  private readonly _config: CredentialsConfig;
  private readonly _awsConfigPath: string;

  private constructor(config: CredentialsConfig, awsConfigPath: string) {
    this._config = config;
    this._awsConfigPath = awsConfigPath;
  }

  /**
   * Creates an AwsCred instance by loading configuration from ~/.aws/config
   */
  public static async load(): Promise<AwsCred> {
    const awsConfigPath = `${homedir()}/.aws/config`;
    const config = await AwsCred.loadAwsConfig(awsConfigPath);
    return new AwsCred(config, awsConfigPath);
  }

  /**
   * Load and parse the AWS config file
   */
  private static async loadAwsConfig(configPath: string): Promise<CredentialsConfig> {
    const result: CredentialsConfig = {
      session: {},
      profile: {},
    };

    if (!(await exists(configPath))) {
      throw new Error(`AWS config file not found at ${configPath}`);
    }

    try {
      const fileContent = await readFile(configPath, "utf-8");
      const rawConfig = parseINI(fileContent) as RawIniConfig;

      for (const sectionName of Object.keys(rawConfig)) {
        const section = rawConfig[sectionName];
        if (!section) {
          continue;
        }

        if (sectionName.startsWith("sso-session ")) {
          // Parse SSO session section
          const sessionName = sectionName.replace("sso-session ", "");
          result.session[sessionName] = {
            ssoStartUrl: section.sso_start_url ?? "",
            ssoRegion: section.sso_region ?? "",
            ssoRegistrationScopes: section.sso_registration_scopes ?? "",
          };
        } else if (sectionName.startsWith("profile ")) {
          // Parse profile section
          const profileName = sectionName.replace("profile ", "");
          result.profile[profileName] = {
            region: section.region ?? "",
            ssoSession: section.sso_session ?? "",
            ssoAccountId: section.sso_account_id ?? "",
            ssoRoleName: section.sso_role_name ?? "",
          };
        }
      }
    } catch (e) {
      throw new Error(`Failed to load AWS config: ${e instanceof Error ? e.message : "Unknown error"}`);
    }

    return result;
  }

  /**
   * Gets the path to the AWS config file
   */
  public get awsConfigPath(): string {
    return this._awsConfigPath;
  }

  /**
   * Gets the client name (hostname)
   */
  public get clientName(): string {
    return hostname();
  }

  /**
   * Returns a list of profile names
   */
  public listProfiles(): string[] {
    return Object.keys(this._config.profile);
  }

  /**
   * Returns a specific profile by name
   */
  public getProfile(name: string): CredentialsConfigProfile | undefined {
    return this._config.profile[name];
  }

  /**
   * Returns all profiles
   */
  public getProfiles(): { [name: string]: CredentialsConfigProfile } {
    return this._config.profile;
  }

  /**
   * Returns the SSO session configuration
   * Returns the first session if multiple exist
   */
  public getSession(): CredentialsConfigSession | undefined {
    const sessionNames = Object.keys(this._config.session);
    if (sessionNames.length === 0) {
      return undefined;
    }
    return this._config.session[sessionNames[0] as string];
  }

  /**
   * Returns a specific SSO session by name
   */
  public getSessionByName(name: string): CredentialsConfigSession | undefined {
    return this._config.session[name];
  }

  /**
   * Returns all SSO sessions
   */
  public getSessions(): { [name: string]: CredentialsConfigSession } {
    return this._config.session;
  }
}

export { AwsCred };
