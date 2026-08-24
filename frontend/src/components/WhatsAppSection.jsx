import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageCircle, QrCode, LogOut, RefreshCw, CheckCircle2, Plus, Star, Trash2, Check, Clock,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, Input, SectionHeading, Skeleton, Spinner, Surface } from "./ui.jsx";
import { formatDateTime } from "../lib/format.js";

/**
 * Linked WhatsApp devices.
 *
 * Several phones can be paired at once — each gets its own QR and its own
 * credential store, and the composer picks which one sends. Replies are matched
 * back to the device that received them, so two phones talking to the same lead
 * never cross wires.
 *
 * A device row is created *before* pairing, because its credential folder is
 * keyed by the row id. The phone number is learned from WhatsApp at scan time,
 * never typed in.
 */

const statusTone = (device) => {
  if (device.connected) return "var(--color-positive)";
  if (device.status === "ERROR") return "var(--color-critical)";
  if (device.status === "PAIRING" || device.hasSession) return "var(--color-caution)";
  return undefined;
};

const statusLabel = (device) => {
  if (device.connected) return device.phoneNumber ? `Connected · +${device.phoneNumber}` : "Connected";
  if (device.status === "ERROR") return "Needs attention";
  if (device.status === "PAIRING") return "Waiting for scan";
  if (device.hasSession) return "Reconnecting…";
  return "Not paired";
};

const DeviceRow = ({ device }) => {
  const queryClient = useQueryClient();
  const [qr, setQr] = useState(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["whatsapp-status"] });

  // Pairing succeeded — drop the QR image.
  useEffect(() => { if (device.connected) setQr(null); }, [device.connected]);

  const connect = useMutation({
    mutationFn: (forceNew) => api.whatsappSession({ accountId: device.id, forceNew }),
    onSuccess: (data) => {
      if (data.status === "connected") {
        setQr(null);
        toast.success(`${device.label} connected as ${data.user?.number || "your device"}.`);
      } else if (data.status === "qr_required") {
        setQr(data.qrCode);
        toast.info(`Scan the QR with the phone for "${device.label}".`);
      } else if (data.status === "initializing") {
        toast.info("Still connecting — try again in a few seconds.");
      } else {
        toast.error(`Could not connect (${data.detail || data.status}). Try again.`);
      }
      invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const logout = useMutation({
    mutationFn: () => api.whatsappLogout(device.id),
    onSuccess: (data) => { setQr(null); toast.success(data?.message || "Disconnected."); invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  const makeDefault = useMutation({
    mutationFn: () => api.setDefaultWhatsAppAccount(device.id),
    onSuccess: (data) => { toast.success(data?.message || "Default updated."); invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteWhatsAppAccount(device.id),
    onSuccess: (data) => { toast.success(data?.message || "Device removed."); invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  const updateFollowUp = useMutation({
    mutationFn: (body) => api.updateWhatsAppAccount(device.id, body),
    onSuccess: () => { toast.success("Follow-up settings saved."); invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  const cadence = Array.isArray(device.followUpDays) ? device.followUpDays : [3, 7];
  const cadenceText = cadence
    .slice(0, device.maxFollowUps)
    .map((d, i) => (i === 0 ? `after ${d} days` : `then ${d} more`))
    .join(", ");

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-medium">{device.label}</p>
            {device.isDefault && <Badge tone="var(--color-positive)"><Star size={9} />Default</Badge>}
            <Badge tone={statusTone(device)}>
              {device.connected ? <CheckCircle2 size={10} /> : null}
              {statusLabel(device)}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
            {device.lastError
              ? device.lastError
              : device.lastConnectedAt
                ? `Last connected ${formatDateTime(device.lastConnectedAt)}`
                : "Never paired yet"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!device.connected && (
            <Button size="sm" onClick={() => connect.mutate(false)} disabled={connect.isPending}>
              {connect.isPending ? <Spinner size={12} /> : <QrCode size={12} />}
              {qr ? "Refresh QR" : "Connect"}
            </Button>
          )}
          {!device.connected && device.hasSession && (
            <Button size="sm" variant="secondary" onClick={() => connect.mutate(true)} disabled={connect.isPending} title="Wipe the pairing and start over">
              <RefreshCw size={12} />New QR
            </Button>
          )}
          {device.connected && (
            <Button size="sm" variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              <LogOut size={12} />Disconnect
            </Button>
          )}
          {!device.isDefault && (
            <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate()} disabled={makeDefault.isPending} title="Make default sender">
              <Star size={12} />
            </Button>
          )}
          <Button
            size="sm" variant="ghost" title="Remove device"
            onClick={() => {
              if (window.confirm(`Remove "${device.label}"? Conversations stay on the leads.`)) remove.mutate();
            }}
            disabled={remove.isPending}
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </div>

      {/*
        Chasing settings live on the device, not globally: a shared sales phone
        and a personal one rarely want the same cadence, and WhatsApp is far
        less forgiving than email about unattended messages to strangers.
      */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--border)] px-3.5 py-2.5">
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={device.autoFollowUp ?? true}
            disabled={updateFollowUp.isPending}
            onChange={(e) => updateFollowUp.mutate({ autoFollowUp: e.target.checked })}
          />
          <span className="text-[var(--text)]">Chase automatically when there is no reply</span>
          {device.autoFollowUp && device.maxFollowUps > 0 && (
            <span className="inline-flex items-center gap-1 text-[var(--text-subtle)]">
              <Clock size={10} />{cadenceText}
            </span>
          )}
        </label>

        <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          Max follow-ups
          <Input
            type="number" min="0" max="5"
            className="w-16 px-2 py-1 text-[12px]"
            defaultValue={device.maxFollowUps ?? 2}
            disabled={updateFollowUp.isPending}
            onBlur={(e) => {
              const next = Number(e.target.value);
              if (Number.isInteger(next) && next >= 0 && next <= 5 && next !== device.maxFollowUps) {
                updateFollowUp.mutate({ maxFollowUps: next });
              }
            }}
          />
        </label>
      </div>

      {qr && !device.connected && (
        <div className="flex flex-col items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-sunken)] p-4">
          <img src={qr} alt={`WhatsApp pairing QR code for ${device.label}`} className="size-52 rounded-lg bg-white p-2" />
          <p className="text-center text-xs text-[var(--text-muted)]">
            On the phone for <strong>{device.label}</strong>: WhatsApp → Settings → Linked devices →
            Link a device, then scan this code. The badge turns green once paired.
          </p>
        </div>
      )}
    </li>
  );
};

const AddDevice = ({ onDone }) => {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");

  const create = useMutation({
    mutationFn: () => api.createWhatsAppAccount({ label: label.trim() }),
    onSuccess: (data) => {
      toast.success(data?.message || "Device added.");
      queryClient.invalidateQueries({ queryKey: ["whatsapp-status"] });
      onDone();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3.5">
      <label className="min-w-52 flex-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
          Device name<span className="ml-1 normal-case">so you can tell your phones apart</span>
        </span>
        <Input
          className="mt-1 w-full"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && label.trim() && create.mutate()}
          placeholder="Sales phone"
          autoFocus
        />
      </label>
      <Button onClick={() => create.mutate()} disabled={!label.trim() || create.isPending}>
        {create.isPending ? <Spinner size={13} /> : <Check size={13} />}Add
      </Button>
      <Button variant="ghost" onClick={onDone}>Cancel</Button>
    </div>
  );
};

export default function WhatsAppSection() {
  const [adding, setAdding] = useState(false);
  const { data: status, isPending } = useQuery({
    queryKey: ["whatsapp-status"],
    queryFn: api.whatsappStatus,
    // Poll faster while any device is mid-pairing, so the badge flips to green
    // on its own the moment the phone scans.
    refetchInterval: (q) =>
      (q.state.data?.accounts || []).some((d) => d.pendingQr || d.status === "PAIRING") ? 5_000 : 30_000,
  });
  const devices = status?.accounts || [];
  const connectedCount = devices.filter((d) => d.connected).length;

  return (
    <Surface className="p-5">
      <SectionHeading
        icon={MessageCircle}
        title="WhatsApp devices"
        description="Link one or more phones. The composer picks which one sends, and replies are tracked back to the right lead automatically."
        actions={
          <div className="flex items-center gap-2">
            {devices.length > 0 && (
              <Badge tone={connectedCount ? "var(--color-positive)" : undefined}>
                {connectedCount ? <CheckCircle2 size={10} /> : null}
                {connectedCount}/{devices.length} connected
              </Badge>
            )}
            {!adding && (
              <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                <Plus size={13} />Add device
              </Button>
            )}
          </div>
        }
      />

      {isPending ? <Skeleton className="h-16" /> : (
        <div className="space-y-3">
          {adding && <AddDevice onDone={() => setAdding(false)} />}

          {devices.length === 0 && !adding && (
            <p className="rounded-lg border border-dashed border-[var(--border-strong)] p-4 text-center text-xs text-[var(--text-muted)]">
              No devices yet. Add one, scan its QR code, and you can send WhatsApp outreach from the lead page.
            </p>
          )}

          <ul className="space-y-2">
            {devices.map((d) => <DeviceRow key={d.id} device={d} />)}
          </ul>

          <p className="border-t border-[var(--border)] pt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Uses your own WhatsApp accounts through the linked-devices feature. Send thoughtfully —
            suppressed contacts and do-not-contact leads are blocked here too, and WhatsApp may
            restrict accounts that message many strangers who report them.
          </p>
        </div>
      )}
    </Surface>
  );
}
