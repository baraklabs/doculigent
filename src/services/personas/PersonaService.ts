import type { CustomPersona } from "@shared/types/persona";

export const PersonaService = {
  list(): Promise<CustomPersona[]> {
    return window.api.persona.list();
  },
  save(persona: CustomPersona): Promise<CustomPersona> {
    return window.api.persona.save(persona);
  },
  delete(id: string): Promise<void> {
    return window.api.persona.delete(id);
  },
};
