import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CustomPersona } from "@shared/types/persona";
import { PersonaService } from "../services/personas/PersonaService";

export function useCustomPersonas() {
  return useQuery<CustomPersona[]>({
    queryKey: ["customPersonas"],
    queryFn: () => PersonaService.list(),
  });
}

function useInvalidateCustomPersonas() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["customPersonas"] });
}

export function useSaveCustomPersona() {
  const invalidate = useInvalidateCustomPersonas();
  return useMutation({
    mutationFn: (persona: CustomPersona) => PersonaService.save(persona),
    onSuccess: invalidate,
  });
}

export function useDeleteCustomPersona() {
  const invalidate = useInvalidateCustomPersonas();
  return useMutation({
    mutationFn: (id: string) => PersonaService.delete(id),
    onSuccess: invalidate,
  });
}
