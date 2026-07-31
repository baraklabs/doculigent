import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { AppIntegration, AppIntegrationKind } from "@shared/types/models";
import * as store from "../native/settingsStore";
import { deleteAppSecret, getAppSecret, setAppSecret } from "../native/keyring";
import { testAppConnection } from "../apps";

export function registerAppsIpc(): void {
  ipcMain.handle(Channels.apps.list, async (): Promise<AppIntegration[]> => store.listAppIntegrations());

  ipcMain.handle(
    Channels.apps.save,
    async (_event, integration: AppIntegration, secret?: string | null): Promise<void> => {
      if (secret) await setAppSecret(integration.id, secret);
      store.saveAppIntegration(integration);
    }
  );

  ipcMain.handle(Channels.apps.delete, async (_event, id: string): Promise<void> => {
    await deleteAppSecret(id);
    store.deleteAppIntegration(id);
  });

  // Mirrors ai.ts's testConnection contract exactly: never throws over IPC, always
  // resolves {ok, message} so the form can render success/failure inline. `secretOverride`
  // lets the form test with an unsaved, just-typed value before hitting Save, falling back
  // to the saved keychain secret (by integrationId) only when no override was given.
  ipcMain.handle(
    Channels.apps.testConnection,
    async (
      _event,
      kind: AppIntegrationKind,
      integrationId: string | null,
      secretOverride?: string | null
    ): Promise<{ ok: boolean; message: string }> => {
      try {
        const secret = secretOverride || (integrationId ? await getAppSecret(integrationId) : null);
        if (!secret) throw new Error("Enter a value to test.");
        await testAppConnection(kind, secret);
        return { ok: true, message: "Connected successfully." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
