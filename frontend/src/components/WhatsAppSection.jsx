import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, QrCode, LogOut, RefreshCw, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, SectionHeading, Skeleton, Spinner, Surface } from "./ui.jsx";

/**
 * WhatsApp device pairing: scan the QR once with the phone that should send
 * outreach (WhatsApp → Linked devices), and the session persists until logout.
 */
export default function WhatsAppSection() {
  const queryClient = useQueryClient();
  const [qr, setQr] = useState(null);

  const { data: status, isPending } = useQuery({
    queryKey: ["whatsapp-status"],
    queryFn: api.whatsappStatus,
    refetchInterval: qr ? 5_000 : 30_000, // poll faster while a QR is on screen
  });
  const connected = Boolean(status?.connected);
  useEffect(() => {
    if (connected) setQr(null); // pairing succeeded — drop the QR
  }, [connected]);

  const connect = useMutation({
    mutationFn: (forceNew) => api.whatsappSession(forceNew),
    onSuccess: (data) => {
      if (data.status === "connected") {
        setQr(null);
        toast.success(`WhatsApp connected as ${data.user?.number || "your device"}.`);
      } else if (data.status === "qr_required") {
        setQr(data.qrCode);
        toast.info("Scan the QR code with WhatsApp on your phone.");
      } else if (data.status === "initializing") {
        toast.info("Still connecting — try again in a few seconds.");
      } else {
        toast.error(`Could not connect (${data.detail || data.status}). Try again.`);
      }
      queryClient.invalidateQueries({ queryKey: ["whatsapp-status"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const logout = useMutation({
    mutationFn: api.whatsappLogout,
    onSuccess: () => {
      setQr(null);
      toast.success("WhatsApp disconnected.");
      queryClient.invalidateQueries({ queryKey: ["whatsapp-status"] });
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Surface className="p-5">
      <SectionHeading
        icon={MessageCircle}
        title="WhatsApp sending"
        description="Pair the phone you send outreach from. Messages go out from your own WhatsApp; replies are tracked on the lead automatically."
        actions={
          <Badge tone={connected ? "var(--color-positive)" : undefined}>
            {connected ? <CheckCircle2 size={10} /> : null}
            {connected ? `Connected · ${status?.user?.number || ""}` : status?.hasSession ? "Reconnecting…" : "Not paired"}
          </Badge>
        }
      />

      {isPending ? <Skeleton className="h-16" /> : (
        <div className="space-y-4">
          {qr && !connected && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
              <img src={qr} alt="WhatsApp pairing QR code" className="size-52 rounded-lg bg-white p-2" />
              <p className="text-center text-xs text-[var(--text-muted)]">
                On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.
                The badge above turns green once paired.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!connected && (
              <Button onClick={() => connect.mutate(false)} disabled={connect.isPending}>
                {connect.isPending ? <Spinner size={13} /> : <QrCode size={13} />}
                {qr ? "Refresh QR" : "Connect WhatsApp"}
              </Button>
            )}
            {connected && (
              <Button variant="danger" onClick={() => logout.mutate()} disabled={logout.isPending}>
                <LogOut size={13} />Disconnect
              </Button>
            )}
            {!connected && status?.hasSession && (
              <Button variant="secondary" onClick={() => connect.mutate(true)} disabled={connect.isPending}>
                <RefreshCw size={13} />Start over with a new QR
              </Button>
            )}
          </div>

          <p className="border-t border-[var(--border)] pt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Uses your own WhatsApp account through the linked-devices feature. Send thoughtfully —
            suppressed contacts and do-not-contact leads are blocked here too, and WhatsApp may
            restrict accounts that message many strangers who report them.
          </p>
        </div>
      )}
    </Surface>
  );
}
