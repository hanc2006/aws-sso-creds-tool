// env variables
import { homedir, hostname } from "os";
import Conf from "conf";
const config = new Conf({
  defaults: {
    region: "us-east-1",
    ssoUrl: "https://<your-project>.awsapps.com/start#/",
    useAccountId: true,
    defaultSection: "<account-id>_<role-name>",
    accounts: "account1, account2, account3",
  },
});

const ssoUrl = config.get("ssoUrl");
if (!ssoUrl) {
  throw new Error("please set the sso default url");
}
export const startUrl: string = ssoUrl;
export const awsCredentialsPath: string =
  config.get("awsCredentialsPath") ?? `${homedir()}/.aws/credentials`;
export const useAccountId = config.get("useAccountId") as boolean;
const accountsConfig = config.get("accounts");
export const sso_accounts: string[] = accountsConfig ? accountsConfig.split(",") : [];
export const region: string = config.get("region") ?? "us-east-1";
export const clientName: string = hostname();
export const defaultSection: string = config.get("defaultSection") ?? "ViewOnlyAccess";
