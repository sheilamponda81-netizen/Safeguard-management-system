import { useState, useEffect } from 'react';
import { Calendar, Save, AlertCircle, RefreshCw, ChevronRight } from 'lucide-react';
import { Button, Badge, Modal } from '../components/ui';
import { supabase } from '../lib/supabase';
import {
  getSystemCurrentMonth,
  setSystemCurrentMonth,
  getMonthLabel,
  getAvailableMonthsFromSystem,
  getPastMonths,
  getNextMonth
} from '../utils/currentMonth';
import { showNotification } from '../utils/clickHandlers';
import { canChangeCurrentPayrollMonth } from '../utils/permissions';

interface MonthSettingsProps {
  onMonthChange?: (month: string) => void;
}

// Only the 2 columns this component's own query selects -- narrower than
// the shared UserProfile type, which assumes a `*, regions(*)` select.
interface MonthSettingsProfile {
  is_super_admin: boolean;
  role_level: number;
}

export function MonthSettings({ onMonthChange }: MonthSettingsProps) {
  const [currentMonth, setCurrentMonth] = useState<string>('');
  const [selectedMonth, setSelectedMonth] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [userProfile, setUserProfile] = useState<MonthSettingsProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Get available months (current and future)
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  // Get past months for display
  const [pastMonths, setPastMonths] = useState<string[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('is_super_admin, role_level')
            .eq('id', user.id)
            .single();
          
          if (profileError) {
            console.error('Error fetching profile:', profileError);
          } else {
            setUserProfile(profile);
          }
        }
        
        const month = await getSystemCurrentMonth();
        setCurrentMonth(month);
        setSelectedMonth(month);
        
        // Get available months from current month forward
        const futureMonths = getAvailableMonthsFromSystem(month);
        setAvailableMonths(futureMonths);
        
        // Get past months for display (optional)
        const past = getPastMonths(month);
        setPastMonths(past);
        
      } catch (err) {
        console.error('Error fetching data:', err);
        setError('Failed to load current month settings');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const handleSaveMonth = async () => {
    if (!selectedMonth) {
      showNotification('Please select a month', 'error');
      return;
    }
    
    setSaving(true);
    setError(null);
    
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        showNotification('User not authenticated', 'error');
        setSaving(false);
        return;
      }
      
      // Friendly, non-authoritative pre-check (delegates to the shared
      // canChangeCurrentPayrollMonth, also used by canChangeMonth below,
      // so the two can never drift) -- the real boundary is the key-aware
      // system_settings RLS policy, which independently rejects a
      // non-super-admin's UPDATE regardless of this check.
      if (!canChangeCurrentPayrollMonth(userProfile)) {
        showNotification('Only a Super Administrator can change the current month', 'error');
        setSaving(false);
        return;
      }
      
      const success = await setSystemCurrentMonth(selectedMonth, user.id);
      if (success) {
        setCurrentMonth(selectedMonth);
        showNotification(`Current month set to ${getMonthLabel(selectedMonth)}`, 'success');
        if (onMonthChange) {
          onMonthChange(selectedMonth);
        }
        setShowModal(false);
      } else {
        setError('Failed to update current month. Please check console for details.');
        showNotification('Failed to update current month', 'error');
      }
    } catch (err) {
      console.error('Error saving month:', err);
      setError('An unexpected error occurred');
      showNotification('An unexpected error occurred', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Quick advance to next month
  const advanceToNextMonth = async () => {
    const nextMonth = getNextMonth(currentMonth);
    if (nextMonth) {
      setSelectedMonth(nextMonth);
      // Auto-save when advancing
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setSaving(true);
        const success = await setSystemCurrentMonth(nextMonth, user.id);
        if (success) {
          setCurrentMonth(nextMonth);
          showNotification(`Advanced to ${getMonthLabel(nextMonth)}`, 'success');
          if (onMonthChange) {
            onMonthChange(nextMonth);
          }
        }
        setSaving(false);
      }
    }
  };

  const canChangeMonth = canChangeCurrentPayrollMonth(userProfile);

  if (loading) {
    return (
      <div className="flex items-center gap-3">
        <div className="w-5 h-5 border-2 border-[#D4A017] border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-slate-500">Loading month...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
        <div className="flex items-center gap-2 text-red-600">
          <AlertCircle size={18} />
          <span className="text-sm">{error}</span>
        </div>
        <button 
          onClick={() => window.location.reload()} 
          className="mt-2 text-sm text-red-600 hover:underline flex items-center gap-1"
        >
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-lg bg-[#081C3A] text-[#D4A017] flex items-center justify-center">
            <Calendar size={20} />
          </div>
          <div>
            <p className="text-sm text-slate-500">Current System Month</p>
            <p className="text-lg font-bold text-[#081C3A]">
              {getMonthLabel(currentMonth)}
            </p>
          </div>
        </div>
        {canChangeMonth && (
          <>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={advanceToNextMonth}
              disabled={saving}
              className="text-xs ml-2"
              title="Advance to next month"
            >
              <ChevronRight size={14} className="mr-1" /> Next Month
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowModal(true)}
              className="text-xs"
            >
              <Calendar size={14} className="mr-1" /> Change Month
            </Button>
          </>
        )}
        {!canChangeMonth && (
          <Badge color="gray" className="text-xs ml-4">
            Read Only
          </Badge>
        )}
      </div>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title="Set Current Payroll Month"
        size="md"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Select the current payroll month. The system will use this as the default month
            for payroll, payments, and reports. You can also use the "Next Month" button
            to quickly advance when the month ends.
          </p>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Select Current Month
            </label>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            >
              {/* Show future months first (current and beyond) */}
              <optgroup label="Current & Future Months">
                {availableMonths.map((month) => (
                  <option key={month} value={month}>
                    {getMonthLabel(month)} {month === currentMonth ? '(Current)' : ''}
                  </option>
                ))}
              </optgroup>
              
              {/* Show past months for reference */}
              {pastMonths.length > 0 && (
                <optgroup label="Past Months (Historical)">
                  {pastMonths.map((month) => (
                    <option key={month} value={month}>
                      {getMonthLabel(month)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <p className="text-xs text-slate-400 mt-1">
              Past months are available for historical reference but the system will default to the current month.
            </p>
          </div>

          <div className="p-3 rounded-lg bg-[#E8EDF5] text-sm text-slate-700">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="text-[#081C3A] shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Current setting: {getMonthLabel(currentMonth)}</p>
                <p className="text-xs text-slate-500 mt-1">
                  When the month ends, use the "Next Month" button or select a new month here.
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-600">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
            <Button variant="outline" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button 
              variant="secondary" 
              onClick={handleSaveMonth} 
              disabled={saving || selectedMonth === currentMonth}
            >
              <Save size={14} className="mr-1" />
              {saving ? 'Saving...' : 'Save Month'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}