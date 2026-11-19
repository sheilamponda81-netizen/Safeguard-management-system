// Final Phase 2 release review: replaces the grid's previous native
// prompt dialog for the now-mandatory attendance_correct reason with
// a small accessible dialog built from this app's existing Modal/
// Input/Button primitives (see CopyFromPreviousModal.tsx for the same
// open/onClose/onConfirm shape this mirrors). A native prompt() has no
// label association, is unstyled/unthemed, and some browsers/extensions
// block it outright -- this keeps the same "ask once per click" flow
// but as a real, keyboard- and screen-reader-accessible form. (Written
// without the literal function name so this file's own source-pinning
// test can assert its real absence, not just this sentence about it.)
import { useState, useEffect } from 'react';
import { Modal, Button, Input } from './ui';

interface AttendanceReasonModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  employeeName: string;
  date: string;
  fromStatus: string;
  toStatus: string;
}

export function AttendanceReasonModal({ open, onClose, onConfirm, employeeName, date, fromStatus, toStatus }: AttendanceReasonModalProps) {
  const [reason, setReason] = useState('');

  // Reset whenever the dialog opens for a (possibly different) cell, so
  // a reason typed for one employee/date/status change can never be
  // silently carried over and reused for the next one.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const trimmed = reason.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Modal open={open} onClose={onClose} title="Reason required" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          Changing <strong>{employeeName}</strong>'s attendance on <strong>{date}</strong> from <strong>{fromStatus}</strong> to <strong>{toStatus}</strong> requires a reason.
        </p>
        <Input
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Guard confirmed present on site, fingerprint scanner was offline"
          required
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!trimmed}>Confirm</Button>
        </div>
      </form>
    </Modal>
  );
}
