import { useState } from "react";
import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { PmPersonaDef } from "@shared/constants/pmPersonas";
import { PM_PERSONAS, listAllPersonas } from "@shared/constants/pmPersonas";
import { useCustomPersonas, useDeleteCustomPersona, useSaveCustomPersona } from "../hooks/useCustomPersonas";
import "./PersonaManagerPanel.css";

const BUILT_IN_IDS = new Set(PM_PERSONAS.map((p) => p.id));

export function PersonaManagerPanel() {
  const { data: customPersonas = [] } = useCustomPersonas();
  const saveMutation = useSaveCustomPersona();
  const deleteMutation = useDeleteCustomPersona();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [focus, setFocus] = useState("");
  const [filePrompt, setFilePrompt] = useState("");
  const [summaryPrompt, setSummaryPrompt] = useState("");

  const personas = listAllPersonas(customPersonas);

  function startNew() {
    setEditingId("");
    setName("");
    setFocus("");
    setFilePrompt("");
    setSummaryPrompt("");
  }

  function startEdit(persona: PmPersonaDef) {
    setEditingId(persona.id);
    setName(persona.name);
    setFocus(persona.focus);
    setFilePrompt(persona.filePrompt ?? "");
    setSummaryPrompt(persona.summaryPrompt ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function save() {
    if (!name.trim()) return;
    await saveMutation.mutateAsync({
      id: editingId || "",
      name: name.trim(),
      focus: focus.trim(),
      filePrompt: filePrompt.trim() || null,
      summaryPrompt: summaryPrompt.trim() || null,
      createdAt: new Date().toISOString(),
    });
    cancelEdit();
  }

  const isOverridden = (id: string) => customPersonas.some((p) => p.id === id);

  return (
    <div className="persona-panel">
      <div className="persona-panel-header">
        <div>
          <h2 className="persona-panel-title">Project Manager personas</h2>
          <p className="muted persona-panel-subtitle">
            Every persona available when creating or configuring an AI Project Manager — edit any of them, including
            the built-in ones, to change what they focus on.
          </p>
        </div>
        <button type="button" className="primary" onClick={startNew} disabled={editingId !== null}>
          + Add persona
        </button>
      </div>

      {editingId !== null && (
        <div className="persona-panel-form">
          <h3>{editingId ? "Edit persona" : "New persona"}</h3>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. QA Lead" autoFocus />
          </label>
          <label className="field">
            <span>Focus</span>
            <textarea
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="What should this persona pay attention to in a recording?"
              rows={3}
            />
          </label>
          <label className="field">
            <span>Individual file prompt (optional)</span>
            <textarea
              value={filePrompt}
              onChange={(e) => setFilePrompt(e.target.value)}
              placeholder="Extra targeting for analyzing one file, beyond the focus above"
              rows={2}
            />
          </label>
          <label className="field">
            <span>Main summary prompt (optional)</span>
            <textarea
              value={summaryPrompt}
              onChange={(e) => setSummaryPrompt(e.target.value)}
              placeholder="Extra targeting for the cross-file overall summary"
              rows={2}
            />
          </label>
          <div className="actions">
            <button type="button" className="primary" onClick={save} disabled={!name.trim() || saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="persona-panel-list">
        {personas.map((persona) => (
          <div key={persona.id} className="persona-panel-row">
            <div className="persona-panel-row-info">
              <span className="persona-panel-row-name">{persona.name}</span>
              <span className="muted persona-panel-row-focus">{persona.focus}</span>
            </div>
            <div className="persona-panel-row-actions">
              <button type="button" className="icon-btn" title="Edit" onClick={() => startEdit(persona)} disabled={editingId !== null}>
                <Pencil size={15} />
              </button>
              {BUILT_IN_IDS.has(persona.id) ? (
                isOverridden(persona.id) && (
                  <button
                    type="button"
                    className="icon-btn"
                    title="Reset to default"
                    onClick={() => deleteMutation.mutate(persona.id)}
                  >
                    <RotateCcw size={15} />
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="icon-btn icon-btn-delete"
                  title="Delete"
                  onClick={() => deleteMutation.mutate(persona.id)}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
