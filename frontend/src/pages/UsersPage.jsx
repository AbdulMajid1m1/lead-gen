import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  UserPlus, ShieldCheck, Eye, Users2, KeyRound, LogOut, Unlock,
  Pencil, Power, Copy, Check, Info,
} from "lucide-react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import {
  Badge, Button, ConfirmDelete, EmptyState, ErrorState, Skeleton, Surface, SectionHeading,
} from "../components/ui.jsx";
import UserFormSheet, { PasswordField, passwordProblem } from "../components/UserFormSheet.jsx";
import { useAuth } from "../lib/auth.jsx";
import { NAV_ITEMS } from "../lib/permissions.js";
import { formatDate, relativeTime } from "../lib/format.js";

/**
 * Team & permissions — the super admin's view of who can reach what.
 *
 * Deactivation is presented as the ordinary way to remove someone and deletion
 * as the sharp one, because that is what they are: deactivating ends every
 * session immediately and keeps the seat attributable, while deleting drops the
 * account and leaves each email they sent identified only by the name snapshot
 * on the message. Both are safe; only one is reversible.
 */

/** Sidebar labels, so a granted key reads the same here as it does in the nav. */
const NAV_LABEL = Object.fromEntries(NAV_ITEMS.map((item) => [item.permission, item.label]));

const ROLE_TONE = {
  ADMIN: "var(--accent)",
  VIEWER: "var(--color-info)",
};

const initialsOf = (member) =>
  (member.name || member.email || "?")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

/**
 * The generated password, shown exactly once.
 *
 * Nothing is emailed to a new colleague — this console has no outbound
 * transactional mail of its own — so the admin has to be able to copy the
 * password before it is gone. It is never retrievable afterwards; the next
 * option is to set a new one.
 */
const NewAccountNotice = ({ account, onDismiss }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${account.email}\n${account.password}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("Your browser blocked the clipboard — select the password and copy it by hand.");
    }
  };

  return (
    <Surface className="border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[var(--accent-soft)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Check size={14} className="text-[var(--accent)]" />
            {account.name} can now sign in
          </h3>
          <p className="mt-1 text-[12px] leading-snug text-[var(--text-muted)]">
            Pass these on yourself — the password is shown once and is not recoverable afterwards.
            Ask them to change it from Settings after their first sign-in.
          </p>
          <dl className="mt-2.5 space-y-1 text-[12px]">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-[var(--text-subtle)]">Email</dt>
              <dd className="min-w-0 break-all font-mono">{account.email}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-[var(--text-subtle)]">Password</dt>
              <dd className="min-w-0 break-all font-mono">{account.password}</dd>
            </div>
          </dl>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={copy}>
            {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss}>Done</Button>
        </div>
      </div>
    </Surface>
  );
};

/** Setting someone else's password. Signs them out everywhere, by design. */
const PasswordResetRow = ({ member, onDone }) => {
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const problem = passwordProblem(password);

  const save = useMutation({
    mutationFn: () => api.setUserPassword(member.id, password),
    onSuccess: () => {
      toast.success(`Password set for ${member.name || member.email}. They have been signed out everywhere.`);
      setPassword("");
      onDone();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="mt-3 space-y-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
      <PasswordField
        label={`New password for ${member.name || member.email}`}
        value={password}
        onChange={(v) => { setPassword(v); setTouched(true); }}
        error={touched ? problem : undefined}
        help="They are signed out of every device as soon as this is saved, and must use the new password."
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
        <Button
          size="sm"
          disabled={Boolean(problem) || save.isPending}
          onClick={() => { setTouched(true); if (!problem) save.mutate(); }}
        >
          <KeyRound size={12} />Set password
        </Button>
      </div>
    </div>
  );
};

const MemberCard = ({ member, isSelf, isLastAdmin, onEdit }) => {
  const [resetting, setResetting] = useState(false);
  const queryClient = useQueryClient();

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["team"] });

  const setActive = useMutation({
    mutationFn: (isActive) => api.updateUser(member.id, { isActive }),
    onSuccess: (_data, isActive) => {
      toast.success(isActive
        ? `${member.name || member.email} can sign in again.`
        : `${member.name || member.email} has been deactivated and signed out everywhere.`);
      refresh();
    },
    onError: (err) => toast.error(err.message),
  });

  const unlock = useMutation({
    mutationFn: () => api.unlockUser(member.id),
    onSuccess: () => { toast.success("Lockout cleared."); refresh(); },
    onError: (err) => toast.error(err.message),
  });

  const revoke = useMutation({
    mutationFn: () => api.revokeUserSessions(member.id),
    onSuccess: () => { toast.success(`${member.name || member.email} has been signed out on every device.`); refresh(); },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteUser(member.id),
    onSuccess: () => { toast.success("Team member removed. Their outreach history is kept under their name."); refresh(); },
    onError: (err) => toast.error(err.message),
  });

  const busy = setActive.isPending || unlock.isPending || revoke.isPending || remove.isPending;
  // The two rules the API enforces, surfaced as disabled controls with a reason
  // rather than as a toast after the click.
  const protectedSeat = isSelf ? "You cannot change your own seat here." : isLastAdmin ? "This is the last active super admin." : null;

  const sections = member.role === "ADMIN"
    ? null
    : (member.grantedPermissions || []).map((key) => NAV_LABEL[key] || key);

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[11px] font-semibold text-[var(--text-muted)]"
        >
          {initialsOf(member)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{member.name || member.email}</span>
            {isSelf && <Badge>You</Badge>}
            <Badge tone={ROLE_TONE[member.role]}>
              {member.role === "ADMIN" && <ShieldCheck size={10} />}
              {member.role === "VIEWER" && <Eye size={10} />}
              {member.roleLabel}
            </Badge>
            {!member.isActive && <Badge tone="var(--color-critical)">Deactivated</Badge>}
            {member.isLocked && <Badge tone="var(--color-critical)">Locked out</Badge>}
          </div>

          <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]" title={member.email}>{member.email}</p>

          {/* What they actually see. The whole point of the screen, so it is
              spelled out rather than hidden behind a count. */}
          <div className="mt-2">
            {sections === null ? (
              <p className="text-[11px] text-[var(--text-muted)]">Every section, plus team management.</p>
            ) : sections.length === 0 ? (
              <p className="text-[11px] text-[var(--color-critical)]">No sections granted — they would sign in to an empty console.</p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {sections.map((label) => <li key={label}><Badge>{label}</Badge></li>)}
              </ul>
            )}
          </div>

          <p className="mt-2 text-[11px] text-[var(--text-subtle)]">
            {member.lastLoginAt ? `Last signed in ${relativeTime(member.lastLoginAt)}` : "Has never signed in"}
            {typeof member.activeSessionCount === "number" && member.activeSessionCount > 0
              && ` · ${member.activeSessionCount} active session${member.activeSessionCount === 1 ? "" : "s"}`}
            {member.createdByName && ` · added by ${member.createdByName}`}
            {member.createdAt && ` on ${formatDate(member.createdAt)}`}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy} title="Edit name, role and sections">
            <Pencil size={12} />Edit
          </Button>

          {!isSelf && (
            <Button variant="ghost" size="sm" onClick={() => setResetting((r) => !r)} disabled={busy} title="Set a new password">
              <KeyRound size={12} />Password
            </Button>
          )}

          {member.isLocked && (
            <Button variant="ghost" size="sm" onClick={() => unlock.mutate()} disabled={busy} title="Clear the failed-attempt lockout">
              <Unlock size={12} />Unlock
            </Button>
          )}

          {member.activeSessionCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => revoke.mutate()} disabled={busy} title="Sign this person out on every device">
              <LogOut size={12} />Sign out
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActive.mutate(!member.isActive)}
            disabled={busy || Boolean(member.isActive && protectedSeat)}
            title={member.isActive ? (protectedSeat || "Deactivate and sign out everywhere") : "Let this person sign in again"}
          >
            <Power size={12} />{member.isActive ? "Deactivate" : "Reactivate"}
          </Button>

          <ConfirmDelete
            label={`Delete ${member.name || member.email}`}
            confirmLabel="Delete for good"
            title={protectedSeat || "Delete this account"}
            disabled={busy || Boolean(protectedSeat)}
            onConfirm={() => remove.mutate()}
          />
        </div>
      </div>

      {resetting && <PasswordResetRow member={member} onDone={() => setResetting(false)} />}
    </li>
  );
};

export default function UsersPage() {
  const { user } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [newAccount, setNewAccount] = useState(null);

  const { data, isPending, error, refetch } = useQuery({ queryKey: ["team"], queryFn: api.listUsers });
  const { data: catalog } = useQuery({
    queryKey: ["permission-catalog"],
    queryFn: api.permissionCatalog,
    staleTime: Infinity,
  });

  const members = data?.users || [];
  // The seat the API will refuse to demote, deactivate or delete. Computed here
  // so the controls are disabled with a reason rather than failing on click.
  const activeAdmins = members.filter((m) => m.role === "ADMIN" && m.isActive);
  const lastAdminId = activeAdmins.length === 1 ? activeAdmins[0].id : null;

  const openNew = () => { setEditing(null); setSheetOpen(true); };
  const openEdit = (member) => { setEditing(member); setSheetOpen(true); };

  const onSaved = (saved, password) => {
    if (!saved) return;
    if (editing) {
      toast.success(`${saved.name || saved.email} updated. Their access changes immediately.`);
      return;
    }
    // Shown once, in the page rather than a toast, because it has to be copied.
    setNewAccount({ name: saved.name, email: saved.email, password });
  };

  return (
    <div>
      <PageHeader
        title="Team & permissions"
        description="Add colleagues and decide which sections of the console each of them sees. Every email and message they send is recorded under their name."
        actions={
          <Button onClick={openNew} disabled={!catalog}>
            <UserPlus size={14} />Add team member
          </Button>
        }
      />

      <PageBody className="space-y-5">
        {newAccount && <NewAccountNotice account={newAccount} onDismiss={() => setNewAccount(null)} />}

        <Surface className="overflow-hidden">
          <div className="px-4 pt-4">
            <SectionHeading
              icon={Users2}
              title={`Team${members.length ? ` · ${members.length}` : ""}`}
              description="Permissions take effect immediately — there is no need to sign anyone out after changing them."
            />
          </div>

          {isPending && <div className="space-y-2 p-4"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}
          {error && <div className="p-4"><ErrorState error={error} onRetry={refetch} /></div>}

          {!isPending && !error && members.length === 0 && (
            <div className="p-4">
              <EmptyState
                icon={Users2}
                title="No one else has an account yet"
                description="Add a colleague and tick the sections they need. They will only ever see what you grant."
                action={<Button onClick={openNew}><UserPlus size={14} />Add team member</Button>}
              />
            </div>
          )}

          {members.length > 0 && (
            <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
              {members.map((member) => (
                <MemberCard
                  key={member.id}
                  member={member}
                  isSelf={member.id === user?.id}
                  isLastAdmin={member.id === lastAdminId}
                  onEdit={() => openEdit(member)}
                />
              ))}
            </ul>
          )}
        </Surface>

        <Surface className="p-5">
          <SectionHeading icon={Info} title="How access works" />
          <ul className="space-y-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
            <li>
              <strong className="font-medium text-[var(--text)]">The sidebar is the permission set.</strong>{" "}
              A section that is not ticked does not appear for that person, and the API refuses it even if they
              type the address by hand.
            </li>
            <li>
              <strong className="font-medium text-[var(--text)]">Sends are attributed.</strong>{" "}
              Every email, WhatsApp message and bulk campaign records who sent it, and the lead's history shows
              that name — including after the account is removed.
            </li>
            <li>
              <strong className="font-medium text-[var(--text)]">Only a super admin manages the team.</strong>{" "}
              It is deliberately not a tick box: anyone who could grant it could grant themselves everything else
              a moment later.
            </li>
            <li>
              <strong className="font-medium text-[var(--text)]">Changes are immediate.</strong>{" "}
              Access is re-read on every request, so removing a section takes effect on the person's next click,
              not when their session expires.
            </li>
          </ul>
        </Surface>
      </PageBody>

      <UserFormSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        member={editing}
        catalog={catalog}
        onSaved={onSaved}
      />
    </div>
  );
}
