import { homedir, hostname } from "os";
import ConfModule from "conf";

// Handle default export from CommonJS module
const Conf = ConfModule.default ?? ConfModule;

interface ConfigSchema {
  region: string;
  ssoUrl: string;
  useAccountId: boolean;
  defaultSection: string;
  accounts: string;
  awsCredentialsPath?: string;
}

interface ConfInstance {
  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K];
}

type ConfConstructor = new (options: {
  projectName: string;
  defaults: ConfigSchema;
}) => ConfInstance;

const config = new (Conf as ConfConstructor)({
  projectName: "auto-aws-sso-creds",
  defaults: {
    region: "us-east-1",
    ssoUrl: "https://<your-project>.awsapps.com/start#/",
    useAccountId: true,
    defaultSection: "<account-id>_<role-name>",
    accounts: "account1, account2, account3",
  },
});

const ssoUrl = config.get("ssoUrl");
if (!ssoUrl || ssoUrl === "https://<your-project>.awsapps.com/start#/") {
  throw new Error(
    "Please set the SSO URL. Use: npx conf set ssoUrl <your-sso-url> --cwd auto-aws-sso-creds"
  );
}

export const startUrl: string = ssoUrl;
export const awsCredentialsPath: string =
  config.get("awsCredentialsPath") ?? `${homedir()}/.aws/credentials`;
export const useAccountId: boolean = config.get("useAccountId");
export const sso_accounts: string[] = config
  .get("accounts")
  ?.split(",")
  .map((s) => s.trim())
  .filter((s) => s) ?? [];
export const region: string = config.get("region") ?? "us-east-1";
export const clientName: string = hostname();
export const defaultSection: string =
  config.get("defaultSection") ?? "ViewOnlyAccess";
