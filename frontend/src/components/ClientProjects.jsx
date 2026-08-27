import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Plus, Pencil, ExternalLink, Check, Calendar } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, ConfirmDelete, FormField, Input, Select, SectionHeading, Spinner, Surface, Textarea } from "./ui.jsx";
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_TONE, formatDate, prettyUrl, toDateInput } from "../lib/format.js";

/**
 * What we have built for this client.
 *
 * The list exists to make one sentence writable without opening a file:
 * "we built you X in March — does it still need anything, and is there a Y?"
 * So the link and the delivery date are the two things given the most weight.
 */

const emptyForm = () => ({ name: "", url: "", description: "", status: "DELIVERED", startedAt: "", deliveredAt: "" });

const formFrom = (p) => ({
  name: p.name || "",
  url: p.url || "",
  description: p.description || "",
  status: p.status || "DELIVERED",
  startedAt: toDateInput(p.startedAt),
  deliveredAt: toDateInput(p.deliveredAt),
});

const validate = (form) => {
  const errors = {};
  if (!form.name.trim()) errors.name = "Give the project a name you would recognise a year from now.";
  if (form.url.trim() && !/^[^\s]+\.[^\s]{2,}/.test(form.url.trim().replace(/^https?:\/\//i, ""))) {
    errors.url = "Enter a web address like app.acme.com.";
  }
  if (form.startedAt && form.deliveredAt && form.deliveredAt < form.startedAt) {
    errors.deliveredAt = "Delivery cannot be before the start date.";
  }
  return errors;
};

const ProjectEditor = ({ clientId, project, onDone }) => {
  const queryClient = useQueryClient();
  const isNew = !project;
  const [form, setForm] = useState(() => (project ? formFrom(project) : emptyForm()));
  const [touched, setTouched] = useState(false);
  const errors = validate(form);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        url: form.url.trim(),
        description: form.description.trim(),
        status: form.status,
        startedAt: form.startedAt,
        deliveredAt: form.deliveredAt,
      };
      return isNew ? api.createClientProject(clientId, body) : api.updateClientProject(clientId, project.id, body);
    },
    onSuccess: (data) => {
      toast.success(data?.message || "Project saved.");
      queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["client-facets"] });
      onDone();
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length) return;
    save.mutate();
  };
  const show = (key) => (touched ? errors[key] : undefined);

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Project name" required error={show("name")} className="sm:col-span-2">
          {(a) => (
            <Input {...a} value={form.name} onChange={(e) => set("name")(e.target.value)}
              placeholder="Acme customer portal" maxLength={200} autoFocus />
          )}
        </FormField>

        <FormField label="Project link" hint="optional" error={show("url")} help="Live site, app-store page or repo — whatever you would open to show it.">
          {(a) => <Input {...a} value={form.url} onChange={(e) => set("url")(e.target.value)} placeholder="portal.acme.com" maxLength={500} />}
        </FormField>

        <FormField label="Status" help="Maintenance means it is live and we still look after it.">
          {(a) => (
            <Select {...a} value={form.status} onChange={(e) => set("status")(e.target.value)}>
              {Object.entries(PROJECT_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          )}
        </FormField>

        <FormField label="Started" hint="optional">
          {(a) => <Input {...a} type="date" value={form.startedAt} onChange={(e) => set("startedAt")(e.target.value)} />}
        </FormField>

        <FormField label="Delivered" hint="optional" error={show("deliveredAt")}>
          {(a) => <Input {...a} type="date" value={form.deliveredAt} onChange={(e) => set("deliveredAt")(e.target.value)} />}
        </FormField>
      </div>

      <FormField label="Details" hint="optional" help="What it does, what it runs on, anything you would want to reread before calling them.">
        {(a) => (
          <Textarea {...a} rows={4} value={form.description} onChange={(e) => set("description")(e.target.value)} maxLength={4000}
            placeholder="Next.js + Postgres order portal replacing their spreadsheet. Handed over with a 6-month support window ending March." />
        )}
      </FormField>

      <div className="flex items-center gap-2 border-t border-[var(--border)] pt-3">
        <Button type="submit" disabled={save.isPending || (touched && Object.keys(errors).length > 0)}>
          {save.isPending ? <Spinner size={13} /> : <Check size={13} />}
          {isNew ? "Add project" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
};

const ProjectRow = ({ clientId, project, onEdit }) => {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () => api.deleteClientProject(clientId, project.id),
    onSuccess: (data) => {
      toast.success(data?.message || "Project deleted.");
      queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["client-facets"] });
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[13px] font-semibold">{project.name}</h4>
            <Badge tone={PROJECT_STATUS_TONE[project.status]}>{PROJECT_STATUS_LABELS[project.status]}</Badge>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
            {project.url && (
              <a
                href={project.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
              >
                <ExternalLink size={10} />{prettyUrl(project.url)}
              </a>
            )}
            {(project.startedAt || project.deliveredAt) && (
              <span className="inline-flex items-center gap-1">
                <Calendar size={10} />
                {project.startedAt && `Started ${formatDate(project.startedAt)}`}
                {project.startedAt && project.deliveredAt && " · "}
                {project.deliveredAt && `Delivered ${formatDate(project.deliveredAt)}`}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit} title="Edit project"><Pencil size={12} /></Button>
          <ConfirmDelete
            onConfirm={() => remove.mutate()}
            disabled={remove.isPending}
            label={`Delete ${project.name}`}
            confirmLabel="Delete project"
          />
        </div>
      </div>

      {project.description && (
        <p className="mt-2 whitespace-pre-wrap border-t border-[var(--border)] pt-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
          {project.description}
        </p>
      )}
    </li>
  );
};

export const ClientProjects = ({ clientId, projects }) => {
  const [editing, setEditing] = useState(null); // "new" | project id

  return (
    <Surface className="p-5">
      <SectionHeading
        icon={FolderGit2}
        title="Projects"
        description="What you built for them, and whether it is still live. This is what a check-in call is actually about."
        actions={
          editing !== "new" && (
            <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
              <Plus size={13} />Add project
            </Button>
          )
        }
      />

      <div className="space-y-2">
        {editing === "new" && <ProjectEditor clientId={clientId} project={null} onDone={() => setEditing(null)} />}

        {projects.length === 0 && editing !== "new" && (
          <p className="rounded-lg border border-dashed border-[var(--border-strong)] p-4 text-center text-xs text-[var(--text-muted)]">
            No projects recorded yet. Add the work you delivered — with its link and a line about what it does — and
            every future conversation with this client starts from something concrete.
          </p>
        )}

        <ul className="space-y-2">
          {projects.map((project) =>
            editing === project.id ? (
              <li key={project.id}>
                <ProjectEditor clientId={clientId} project={project} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <ProjectRow key={project.id} clientId={clientId} project={project} onEdit={() => setEditing(project.id)} />
            ),
          )}
        </ul>
      </div>
    </Surface>
  );
};
