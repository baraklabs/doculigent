import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { CustomPersona } from "@shared/types/persona";
import * as store from "../native/settingsStore";

export function registerPersonasIpc(): void {
  ipcMain.handle(Channels.persona.list, async (): Promise<CustomPersona[]> => store.listCustomPersonas());

  ipcMain.handle(Channels.persona.save, async (_event, persona: CustomPersona): Promise<CustomPersona> => {
    const saved: CustomPersona = persona.id ? persona : { ...persona, id: randomUUID() };
    store.saveCustomPersona(saved);
    return saved;
  });

  ipcMain.handle(Channels.persona.delete, async (_event, id: string): Promise<void> => store.deleteCustomPersona(id));
}
