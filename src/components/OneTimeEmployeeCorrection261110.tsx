import { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from './ui';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import { shouldShowCorrectionPanel, getCorrectionRpcArgs } from '../utils/oneTimeCorrectionGate';

// ===== TEMPORARY, ONE-TIME MAINTENANCE ACTION =====
// Corrects the 293 employees imported with temporary SFG-IMP-261110-%
// numbers (uppercases full_name, assigns Central Region, renumbers to
// SFG-C-254..546). Invokes correct_sfg_imp_261110_import() through this
// app's own already-authenticated `supabase` client -- no token is ever
// read, copied, or displayed. Gating logic lives in oneTimeCorrectionGate.ts
// (unit-tested there) so it's covered without rendering this component;
// Super Admin authorization is enforced server-side by the RPC itself
// (this component's own is_super_admin check is UI convenience only, not
// the real security boundary -- the RPC independently re-checks it).
//
// Self-hides once there is nothing left to correct (confirmed via a
// cheap exact count, not a full row fetch) -- after a successful run,
// or if it was already applied by someone else, this card simply
// disappears. Intended to be deleted from this file (and its one import
// line in Misc.tsx) once the correction has been applied and verified,
// alongside dropping the RPC itself (see post_execution_verify_and_cleanup.sql).
export function OneTimeEmployeeCorrection261110() {
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const profile = await getCurrentProfile();
        const { count, error } = await supabase
          .from('employees')
          .select('id', { count: 'exact', head: true })
          .like('employee_number', 'SFG-IMP-261110-%');
        if (!error) {
          setVisible(shouldShowCorrectionPanel(profile, count ?? 0));
        }
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const handleRun = useCallback(async () => {
    const args = getCorrectionRpcArgs(() =>
      confirm(
        'This will permanently renumber all 293 imported employees to SFG-C-254..546, ' +
        'uppercase their names, and assign them to Central Region. This cannot be undone ' +
        'from this screen. Continue?'
      )
    );
    if (!args) return;

    setRunning(true);
    setResult(null);
    try {
      const { data, error } = await supabase.rpc('correct_sfg_imp_261110_import', args);
      if (error) {
        showNotification('Correction failed: ' + getErrorMessage(error), 'error');
        setResult({ success: false, error: getErrorMessage(error) });
        return;
      }
      showNotification('Employee correction completed successfully.', 'success');
      setResult(data as Record<string, unknown>);
      setVisible(false);
    } catch (err) {
      showNotification('Correction failed: ' + getErrorMessage(err), 'error');
      setResult({ success: false, error: getErrorMessage(err) });
    } finally {
      setRunning(false);
    }
  }, []);

  if (checking || (!visible && !result)) return null;

  return (
    <Card className="p-5 border border-amber-300 bg-amber-50">
      <div className="flex items-center gap-2 mb-2">
        <Badge color="yellow">One-Time Maintenance</Badge>
        <h4 className="font-semibold text-slate-800">Correct Imported Employees (SFG-IMP-261110)</h4>
      </div>
      <p className="text-sm text-slate-600 mb-4">
        Renumbers the 293 employees imported with temporary SFG-IMP-261110-% numbers to
        SFG-C-254..546, uppercases their names, and assigns Central Region. Preserves UUIDs,
        positions, salaries, deductions, bank details, statuses (including all 43 deleted
        records), payroll, and attendance. Can only be run by a Super Admin of this tenant, and
        only once -- it self-disables immediately after success.
      </p>
      {visible && (
        <Button variant="secondary" onClick={handleRun} disabled={running}>
          {running ? 'Running…' : 'Run One-Time Correction'}
        </Button>
      )}
      {result && (
        <pre className="mt-4 text-xs bg-white border border-slate-200 rounded-lg p-3 overflow-auto">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </Card>
  );
}
