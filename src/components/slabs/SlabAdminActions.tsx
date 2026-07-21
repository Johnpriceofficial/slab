/**
 * Admin actions for a slab detail page:
 *   - Archive / Unarchive real inventory (preserves number, comps, images).
 *   - A SEPARATE, explicitly-confirmed hard delete for temporary TEST records.
 *     Every destructive route uses the transactional purge and durable storage
 *     cleanup queue; failed object removal remains recoverable and visible.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Archive, ArchiveRestore, Trash2, AlertTriangle } from "lucide-react";
import { archiveSlab, unarchiveSlab, hardDeleteSlab } from "@/lib/slabs/data";
import { useAuth } from "@/auth/AuthProvider";
import type { Slab } from "@/lib/slabs/types";

/**
 * Hard delete is hidden in production builds unless explicitly enabled with
 * VITE_ALLOW_SLAB_HARD_DELETE=true. This is defense in depth on top of the
 * authoritative server-side gate (slab_settings.allow_hard_delete): even if the
 * button is shown, the RPC still refuses unless an admin enabled it in the DB.
 */
const HARD_DELETE_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_ALLOW_SLAB_HARD_DELETE === "true";

export function SlabAdminActions({ slab }: { slab: Slab }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const isArchived = !!slab.archived_at;
  const canHardDelete = HARD_DELETE_ENABLED && status === "admin";

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["slab", slab.id] });

  const toggleArchive = async () => {
    try {
      if (isArchived) {
        await unarchiveSlab(slab.id);
        toast.success("Slab restored to active inventory");
      } else {
        await archiveSlab(slab.id);
        toast.success(`Slab #${slab.inventory_number} archived (number preserved)`);
      }
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  };

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={toggleArchive}>
        {isArchived ? <><ArchiveRestore className="mr-1 h-4 w-4" /> Unarchive</> : <><Archive className="mr-1 h-4 w-4" /> Archive</>}
      </Button>
      {canHardDelete && <HardDeleteDialog slab={slab} onDeleted={() => navigate("/slabs")} />}
    </div>
  );
}

function HardDeleteDialog({ slab, onDeleted }: { slab: Slab; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const doDelete = async () => {
    setBusy(true);
    try {
      const report = await hardDeleteSlab(slab.id);
      if (report.image_errors.length > 0) {
        toast.warning(`Record deleted. ${report.image_errors.length} image cleanup operation(s) remain safely queued for retry: ${report.image_errors.join("; ")}`);
      } else {
        toast.success("Test record and its images were permanently deleted");
      }
      setOpen(false);
      onDeleted();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Delete failed";
      toast.error(
        /HARD_DELETE_DISABLED/.test(msg)
          ? "Hard delete is disabled on this project. Enable the permanent-delete safety switch before removing test records."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); setConfirmed(false); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive">
          <Trash2 className="mr-1 h-4 w-4" /> Delete test record
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Permanently delete a test record</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              This permanently removes slab <strong>#{slab.inventory_number}</strong>, its sales comps, and both images.
              Use archival for real inventory — this is only for temporary test records. Failed image removal remains
              in the protected cleanup queue until it succeeds.
            </p>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>I understand this is permanent and this is a test record.</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="destructive" onClick={doDelete} disabled={!confirmed || busy}>
            {busy ? "Deleting…" : "Permanently delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
