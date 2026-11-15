import { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from './ui';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { showNotification } from '../utils/clickHandlers';
import { getErrorMessage } from '../utils/errorHandler';
import {
  shouldShowLilongwe50CorrectionPanel,
  getLilongwe50CorrectionRpcArgs,
} from '../utils/lilongwe50CorrectionGate';

// ===== TEMPORARY, ONE-TIME MAINTENANCE ACTION =====
// Corrects the 50 existing Lilongwe employees still carrying temporary
// SFG-IMP-261111-% (7) or SFG-LL-261111-% (43) numbers: renumbers them to
// standard SFG-C-% numbers, uppercases full_name, and assigns Central
// Region. Invokes correct_lilongwe_50_region_numbering() through this
// app's own already-authenticated `supabase` client -- no token is ever
// read, copied, or displayed. Gating logic lives in
// lilongwe50CorrectionGate.ts (unit-tested there) so it's covered without
// rendering this component; Super Admin authorization is enforced
// server-side by the RPC itself (this component's own is_super_admin
// check is UI convenience only, not the real security boundary -- the
// RPC independently re-checks it, and separately a BEFORE UPDATE trigger
// on employees requires an admin session for any region_id change, which
// is exactly why this has to run through a real authenticated session
// rather than a direct database connection).
//
// Self-hides once there is nothing left to correct (confirmed via a
// cheap exact count, not a full row fetch) -- after a successful run, or
// if it was already applied by someone else, this card simply
// disappears. Intended to be deleted from this file (and its one import
// line in Misc.tsx) once the correction has been applied and verified,
// alongside dropping the RPC itself.
export function CorrectLilongwe50Employees() {
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(true);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<{
    updated_count?: number;
    min_number?: number;
    max_number?: number;
    prefix?: string;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const profile = await getCurrentProfile();
        const { count, error } = await supabase
          .from('employees')
          .select('id', { count: 'exact', head: true })
          .or('employee_number.like.SFG-IMP-261111-%,employee_number.like.SFG-LL-261111-%');
        if (!error) {
          setVisible(shouldShowLilongwe50CorrectionPanel(profile, count ?? 0));
        }
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const handleRun = useCallback(async () => {
    const args = getLilongwe50CorrectionRpcArgs(() =>
      confirm(
        'This will permanently renumber all 50 Lilongwe employees (7 SFG-IMP-261111-% and ' +
        '43 SFG-LL-261111-%) to standard SFG-C-% numbers, uppercase their names, and assign ' +
        'them to Central Region. This cannot be undone from this screen. Continue?'
      )
    );
    if (!args) return;

    setRunning(true);
    setSummary(null);
    try {
      const { data, error } = await supabase.rpc('correct_lilongwe_50_region_numbering', args);
      if (error) {
        showNotification('Correction failed: ' + getErrorMessage(error), 'error');
        return;
      }
      const result = data as Record<string, unknown>;
      showNotification('Lilongwe 50-employee correction completed successfully.', 'success');
      // Deliberately only the summary counts/range -- never the per-row
      // `outcomes` array the RPC also returns (employee UUIDs and old/new
      // numbers), so nothing employee-identifying is displayed here.
      setSummary({
        updated_count: result.updated_count as number | undefined,
        min_number: result.min_number as number | undefined,
        max_number: result.max_number as number | undefined,
        prefix: result.prefix as string | undefined,
      });
      setVisible(false);
    } catch (err) {
      showNotification('Correction failed: ' + getErrorMessage(err), 'error');
    } finally {
      setRunning(false);
    }
  }, []);

  if (checking || (!visible && !summary)) return null;

  return (
    <Card className="p-5 border border-amber-300 bg-amber-50">
      <div className="flex items-center gap-2 mb-2">
        <Badge color="yellow">One-Time Maintenance</Badge>
        <h4 className="font-semibold text-slate-800">Correct 50 Lilongwe Employees</h4>
      </div>
      <p className="text-sm text-slate-600 mb-4">
        Corrects 50 existing Lilongwe employees with temporary SFG-IMP-261111 and SFG-LL-261111
        numbers. Assigns standard Central Region employee numbers, uppercases names, and assigns
        Central Region. Preserves employee UUIDs, statuses, salaries, deductions, banking
        details, payroll and attendance. Can only be run by a Super Admin of this tenant, and
        only once -- it self-disables immediately after success.
      </p>
      {visible && (
        <Button variant="secondary" onClick={handleRun} disabled={running}>
          {running ? 'Running…' : 'Run One-Time Correction'}
        </Button>
      )}
      {summary && (
        <div className="mt-4 text-sm bg-white border border-slate-200 rounded-lg p-3">
          <p className="text-slate-700">
            Corrected <strong>{summary.updated_count ?? '?'}</strong> employees.
          </p>
          {summary.prefix && summary.min_number != null && summary.max_number != null && (
            <p className="text-slate-500 text-xs mt-1">
              New number range: {summary.prefix}{String(summary.min_number).padStart(3, '0')} –{' '}
              {summary.prefix}{String(summary.max_number).padStart(3, '0')}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
