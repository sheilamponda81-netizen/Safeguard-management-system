import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Search, Calendar, CheckCircle2, XCircle, Clock, Plane, FileText, RefreshCw, Scissors, ChevronLeft, ChevronRight } from '../utils/icons';
import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal } from '../components/ui';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { getAvailableMonthsFromSystem, getSystemCurrentMonth, getMonthLabel, getNextMonth, getPreviousMonth } from '../utils/currentMonth';
import { EmptyState } from '../components/EmptyState';
import { CopyFromPreviousModal } from '../components/CopyFromPreviousModal';
import { sanitizeInput } from '../utils/securityHeaders';
import { logAudit } from '../utils/auditLogger';
import { showNotification } from '../utils/clickHandlers';
import { Pagination } from '../components/Pagination';
import { debounce } from '../utils/debounce';
import { getPayrollRates, DEFAULT_RATES } from '../utils/payrollSettings';
import { getDefaultPageSize } from '../utils/uiSettings';

const statusColors: Record<string, string> = {
  P: 'bg-emerald-500', 
  A: 'bg-red-500', 
  L: 'bg-yellow-400', 
  LV: 'bg-blue-500', 
  SL: 'bg-purple-500', 
  '-': 'bg-slate-200'
};

const statusLabels: Record<string, string> = { 
  P: 'Present', 
  A: 'Absent', 
  L: 'Late', 
  LV: 'Leave', 
  SL: 'Sick', 
  '-': 'Off' 
};

const statusCycle = ['P', 'A', 'L', 'LV', 'SL', '-'];

interface Employee {
  id: string;
  employee_number: string;
  full_name: string;
  position: string;
  department: string;
  status: string;
  region_id?: string;
}

interface AttendanceRecord {
  id: string;
  employee_id: string;
  date: string;
  status: string;
}

export function AttendancePage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [systemMonth, setSystemMonth] = useState('');
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  // Attendance deduction rates -- shared, admin-configurable via Settings ->
  // System (see payrollSettings.ts), instead of the fixed constant these used
  // to be. Payroll.tsx/Payslips.tsx read the same source for the figures they
  // recompute from these attendance records.
  const [deductionRates, setDeductionRates] = useState(DEFAULT_RATES);

  useEffect(() => {
    getPayrollRates().then(setDeductionRates);
  }, []);

  // ===== PAGINATION STATES =====
  const [attendancePage, setAttendancePage] = useState(1);
  const [attendanceItemsPerPage, setAttendanceItemsPerPage] = useState(20);
  useEffect(() => { getDefaultPageSize().then(setAttendanceItemsPerPage); }, []);

  // ===== REFS =====
  const updateQueue = useRef<Map<string, { employeeId: string; date: string; status: string }>>(new Map());
  const isProcessingUpdate = useRef(false);

  // ===== HELPER FUNCTIONS =====
  const getDatesForMonth = useCallback((monthYear: string) => {
    if (!monthYear) return [];
    const [year, month] = monthYear.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const datesArr = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      datesArr.push(dateStr);
    }
    return datesArr;
  }, []);

  // ===== MEMOIZED VALUES =====
  const isCurrentMonth = useMemo(() => selectedMonth === systemMonth, [selectedMonth, systemMonth]);
  const isFutureMonthSelected = useMemo(() => selectedMonth > systemMonth, [selectedMonth, systemMonth]);
  const dates = useMemo(() => getDatesForMonth(selectedMonth), [selectedMonth, getDatesForMonth]);
  
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  const userRegion = useMemo(() => userProfile?.regions, [userProfile]);

  // ===== FETCH USER PROFILE =====
  const fetchUserProfile = useCallback(async () => {
    const profile = await getCurrentProfile();
    setUserProfile(profile);
  }, []);

  // ===== FETCH DATA =====
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let employeesQuery = supabase
        .from('employees')
        .select('id, employee_number, full_name, position, department, status, region_id')
        .eq('is_deleted', false);
        
      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        employeesQuery = employeesQuery.eq('region_id', userProfile.region_id);
      }
      
      const { data: employeesData, error: empError } = await employeesQuery;
      if (empError) throw empError;
      
      setEmployees(employeesData || []);
      
      const datesArr = getDatesForMonth(selectedMonth);
      if (datesArr.length > 0 && employeesData && employeesData.length > 0) {
        const employeeIds = employeesData.map(e => e.id);

        let attendanceQuery = supabase
          .from('attendance')
          .select('*')
          .gte('date', datesArr[0])
          .lte('date', datesArr[datesArr.length - 1])
          .in('employee_id', employeeIds);

        const { data: attendanceData, error: attError } = await attendanceQuery;
        if (attError) throw attError;
        setAttendance(attendanceData || []);
        setHasData((attendanceData || []).length > 0);
      } else {
        setAttendance([]);
        setHasData(false);
      }
    } catch (err: any) {
      console.error('Error fetching data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, userProfile, getDatesForMonth]);

  // ===== INITIALIZATION =====
  useEffect(() => {
    const init = async () => {
      const month = await getSystemCurrentMonth();
      setSystemMonth(month);
      setSelectedMonth(month);
      
      const months = getAvailableMonthsFromSystem(month);
      setAvailableMonths(months);
      
      await fetchUserProfile();
    };
    init();
  }, [fetchUserProfile]);

  useEffect(() => {
    if (userProfile && selectedMonth) {
      fetchData();
    }
  }, [selectedMonth, userProfile, fetchData]);

  // ===== MONTH NAVIGATION =====
  const goToPreviousMonth = useCallback(async () => {
    const prevMonth = getPreviousMonth(selectedMonth);
    if (prevMonth && availableMonths.includes(prevMonth)) {
      setSelectedMonth(prevMonth);
      setAttendancePage(1);
    }
  }, [selectedMonth, availableMonths]);

  const goToNextMonth = useCallback(async () => {
    const nextMonth = getNextMonth(selectedMonth);
    if (nextMonth && availableMonths.includes(nextMonth)) {
      setSelectedMonth(nextMonth);
      setAttendancePage(1);
    }
  }, [selectedMonth, availableMonths]);

  const goToCurrentMonth = useCallback(async () => {
    if (systemMonth && systemMonth !== selectedMonth) {
      setSelectedMonth(systemMonth);
      setAttendancePage(1);
    }
  }, [systemMonth, selectedMonth]);

  const handleMonthSelect = useCallback(async (month: string) => {
    if (month !== selectedMonth) {
      setSelectedMonth(month);
      setAttendancePage(1);
    }
  }, [selectedMonth]);

  // ===== PROCESS UPDATE QUEUE =====
  const processUpdateQueue = useCallback(async () => {
    if (isProcessingUpdate.current || updateQueue.current.size === 0) return;
    
    isProcessingUpdate.current = true;
    
    try {
      const entries = Array.from(updateQueue.current.values());
      updateQueue.current.clear();
      
      // Group updates by employee for efficiency
      const groupedUpdates: Record<string, any[]> = {};
      for (const entry of entries) {
        if (!groupedUpdates[entry.employeeId]) {
          groupedUpdates[entry.employeeId] = [];
        }
        groupedUpdates[entry.employeeId].push(entry);
      }
      
      // Process each employee's updates
      for (const updates of Object.values(groupedUpdates)) {
        for (const update of updates) {
          await processSingleUpdate(update.employeeId, update.date, update.status);
        }
      }
    } catch (err) {
      console.error('Error processing update queue:', err);
    } finally {
      isProcessingUpdate.current = false;
      
      // Process any new updates that came in while we were processing
      if (updateQueue.current.size > 0) {
        setTimeout(processUpdateQueue, 100);
      }
    }
  }, []);

  // ===== PROCESS SINGLE UPDATE =====
  const processSingleUpdate = useCallback(async (employeeId: string, date: string, nextStatus: string) => {
    try {
      const { data: existingRecord, error: checkError } = await supabase
        .from('attendance')
        .select('id')
        .eq('employee_id', employeeId)
        .eq('date', date)
        .maybeSingle();

      if (checkError) throw checkError;

      let result;
      if (existingRecord) {
        result = await supabase
          .from('attendance')
          .update({ status: nextStatus })
          .eq('id', existingRecord.id);
      } else {
        // tenant_id is omitted -- it defaults to the current user's own
        // tenant via the DB column default, same convention used by
        // positions/regions inserts elsewhere in the app. Explicitly
        // passing `tenant_id: null` here previously (when userProfile
        // hadn't finished loading yet) would override that default and
        // violate the NOT NULL constraint, silently failing every insert.
        result = await supabase
          .from('attendance')
          .insert({
            employee_id: employeeId,
            date: date,
            status: nextStatus,
          });
      }

      if (result.error) throw result.error;

    } catch (err: any) {
      console.error('Error processing update:', err);
      showNotification(`Failed to save attendance: ${err.message || 'Unknown error'}`, 'error');
    }
  }, []);

  // ===== OPTIMIZED: UPDATE ATTENDANCE WITH OPTIMISTIC UI =====
  const updateAttendance = useCallback(async (employeeId: string, date: string, currentStatus: string) => {
    const employee = employees.find(e => e.id === employeeId);
    if (!userProfile?.is_super_admin && employee?.region_id !== userProfile?.region_id) {
      showNotification('You can only edit attendance for employees in your region', 'error');
      return;
    }
    
    if (selectedMonth !== systemMonth) {
      showNotification('Attendance can only be edited for the current month.', 'error');
      return;
    }
    
    const currentIndex = statusCycle.indexOf(currentStatus);
    const nextIndex = (currentIndex + 1) % statusCycle.length;
    const nextStatus = statusCycle[nextIndex];
    
    // ===== PERFORMANCE: Optimistic update - change UI immediately =====
    const updateKey = `${employeeId}-${date}`;
    if (updating[updateKey]) return; // Prevent double clicks
    
    setUpdating(prev => ({ ...prev, [updateKey]: true }));
    
    // Update local state immediately for fast UI response
    setAttendance(prev => {
      const existingIndex = prev.findIndex(a => a.employee_id === employeeId && a.date === date);
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = { ...updated[existingIndex], status: nextStatus };
        return updated;
      } else {
        return [...prev, { id: '', employee_id: employeeId, date, status: nextStatus }];
      }
    });
    
    // Queue the update for background processing
    updateQueue.current.set(updateKey, { employeeId, date, status: nextStatus });
    
    // Trigger queue processing
    if (!isProcessingUpdate.current) {
      setTimeout(processUpdateQueue, 50);
    }
    
    // Log audit in background
    try {
      await logAudit({
        action: 'UPDATE',
        entity_type: 'attendance',
        new_data: { 
          status: nextStatus, 
          employee_id: employeeId,
          employee_name: employee?.full_name || 'Unknown',
          employee_number: employee?.employee_number || 'N/A',
          date: date,
          month: selectedMonth
        },
        region_id: userProfile?.region_id
      });
    } catch (err) {
      console.error('Error logging audit:', err);
    } finally {
      setUpdating(prev => {
        const newState = { ...prev };
        delete newState[updateKey];
        return newState;
      });
    }
  }, [employees, userProfile, selectedMonth, systemMonth, updating, processUpdateQueue]);

  // ===== DEBOUNCED UPDATE (per cell) =====
  // A single shared debounce instance (as this used to be, memoized on
  // updateAttendance and recreated every time an update actually commits)
  // has one internal timer regardless of which cell it's called for.
  // Clicking employee A's cell then employee B's cell within the same
  // ~150ms window would cancel A's pending call in favor of B's, silently
  // dropping A's click with no error and no visual change -- a very live
  // risk on this page, since marking several employees' attendance in quick
  // succession is the normal workflow. Keying a separate debounced function
  // per `employeeId-date` cell means each cell's clicks only ever compete
  // with themselves.
  const updateAttendanceRef = useRef(updateAttendance);
  useEffect(() => {
    updateAttendanceRef.current = updateAttendance;
  }, [updateAttendance]);

  const debouncedUpdatesByKey = useRef<Map<string, (employeeId: string, date: string, currentStatus: string) => void>>(new Map());

  const getDebouncedUpdate = useCallback((updateKey: string) => {
    let fn = debouncedUpdatesByKey.current.get(updateKey);
    if (!fn) {
      fn = debounce((employeeId: string, date: string, currentStatus: string) => {
        updateAttendanceRef.current(employeeId, date, currentStatus);
      }, 150);
      debouncedUpdatesByKey.current.set(updateKey, fn);
    }
    return fn;
  }, []);

  // ===== ATTENDANCE LOOKUP INDEXES =====
  // With the employee base heading toward ~2000 records, a linear .find()/
  // .filter() over the whole month's attendance array per employee per cell
  // (previously O(employees x days x records)) gets slow fast. Both indexes
  // are built once per attendance fetch instead of per lookup.
  const attendanceByKey = useMemo(() => {
    const map = new Map<string, string>();
    attendance.forEach(record => {
      map.set(`${record.employee_id}_${record.date}`, record.status);
    });
    return map;
  }, [attendance]);

  const attendanceByEmployee = useMemo(() => {
    const map = new Map<string, AttendanceRecord[]>();
    attendance.forEach(record => {
      const existing = map.get(record.employee_id);
      if (existing) {
        existing.push(record);
      } else {
        map.set(record.employee_id, [record]);
      }
    });
    return map;
  }, [attendance]);

  // ===== GET ATTENDANCE STATUS =====
  const getAttendanceStatus = useCallback((employeeId: string, date: string): string => {
    return attendanceByKey.get(`${employeeId}_${date}`) || '-';
  }, [attendanceByKey]);

  // ===== GET EMPLOYEE STATS =====
  const getEmployeeStats = useCallback((employeeId: string) => {
    const employeeAttendance = attendanceByEmployee.get(employeeId) || [];
    const counts = { P: 0, A: 0, L: 0, LV: 0, SL: 0 };
    employeeAttendance.forEach(record => {
      if (record.status && counts[record.status as keyof typeof counts] !== undefined) {
        counts[record.status as keyof typeof counts]++;
      }
    });
    const total = counts.P + counts.A + counts.L + counts.LV + counts.SL;
    return { ...counts, total };
  }, [attendanceByEmployee]);

  // ===== CALCULATE DEDUCTIONS =====
  const calculateEmployeeDeductions = useCallback((employeeId: string) => {
    const employeeAttendance = attendanceByEmployee.get(employeeId) || [];
    const counts = { A: 0, L: 0 };
    let lectureMissedCount = 0;

    employeeAttendance.forEach(record => {
      if (record.status === 'A') counts.A++;
      if (record.status === 'L') counts.L++;
    });

    const datesArr = getDatesForMonth(selectedMonth);
    datesArr.forEach(date => {
      const dateObj = new Date(date);
      const dayOfWeek = dateObj.getDay();
      if (dayOfWeek === 3 || dayOfWeek === 4) {
        const status = getAttendanceStatus(employeeId, date);
        if (status === 'A') {
          lectureMissedCount++;
        }
      }
    });
    
    const absentDeduction = counts.A * deductionRates.absentDeduction;
    const lateDeduction = counts.L * deductionRates.lateDeduction;
    const attendanceDeduction = absentDeduction + lateDeduction;

    let lectureDeduction = 0;
    if (lectureMissedCount > 0) {
      const totalLectures = datesArr.filter(d => {
        const dayOfWeek = new Date(d).getDay();
        return dayOfWeek === 3 || dayOfWeek === 4;
      }).length;

      if (lectureMissedCount === totalLectures && totalLectures > 0) {
        lectureDeduction = deductionRates.lectureFullMonthDeduction;
      } else {
        lectureDeduction = lectureMissedCount * deductionRates.lectureDeduction;
      }
    }

    const appearanceDeduction = deductionRates.appearanceDeduction;
    const totalDeductions = attendanceDeduction + lectureDeduction + appearanceDeduction;

    return {
      absentDays: counts.A,
      lateDays: counts.L,
      absentDeduction,
      lateDeduction,
      attendanceDeduction,
      lectureMissedCount,
      lectureDeduction,
      appearanceDeduction,
      totalDeductions
    };
  }, [attendanceByEmployee, selectedMonth, getDatesForMonth, getAttendanceStatus, deductionRates]);

  // ===== FILTER EMPLOYEES =====
  const filteredEmployees = useMemo(() => {
    const safeSearch = sanitizeInput(search).toLowerCase();
    return employees.filter(e => 
      e.full_name?.toLowerCase().includes(safeSearch) ||
      e.employee_number?.toLowerCase().includes(safeSearch)
    );
  }, [employees, search]);

  // ===== PAGINATED EMPLOYEES =====
  const paginatedEmployees = useMemo(() => {
    const startIndex = (attendancePage - 1) * attendanceItemsPerPage;
    const endIndex = Math.min(startIndex + attendanceItemsPerPage, filteredEmployees.length);
    return filteredEmployees.slice(startIndex, endIndex);
  }, [filteredEmployees, attendancePage, attendanceItemsPerPage]);

  // ===== RESET PAGE WHEN SEARCH CHANGES =====
  useEffect(() => {
    setAttendancePage(1);
  }, [search]);

  // ===== CALCULATE METRICS =====
  const metrics = useMemo(() => {
    let totalDays = 0;
    let presentDays = 0;
    let absentDays = 0;
    let lateDays = 0;
    let leaveDays = 0;
    attendance.forEach(record => {
      if (record.status !== '-') {
        totalDays++;
        if (record.status === 'P') presentDays++;
        if (record.status === 'A') absentDays++;
        if (record.status === 'L') lateDays++;
        if (record.status === 'LV') leaveDays++;
      }
    });
    const attendanceRate = totalDays > 0 ? (presentDays / totalDays) * 100 : 0;
    const absenteeism = totalDays > 0 ? (absentDays / totalDays) * 100 : 0;
    return { attendanceRate: attendanceRate.toFixed(1), absenteeism: absenteeism.toFixed(1), late: lateDays, leaveRequests: leaveDays };
  }, [attendance]);

  // ===== EXPORT REPORT =====
  const exportReport = useCallback(() => {
    let csv = 'Employee,Position,Department,';
    dates.forEach((_, i) => { csv += `Day ${i + 1},`; });
    csv += 'Present,Absent,Late,Leave,Sick,Absent Deduction,Late Deduction,Lecture Deduction,Appearance Deduction,Total Deductions\n';
    filteredEmployees.forEach(emp => {
      const stats = getEmployeeStats(emp.id);
      const deductions = calculateEmployeeDeductions(emp.id);
      csv += `"${emp.full_name}","${emp.position}","${emp.department}",`;
      dates.forEach(date => {
        const status = getAttendanceStatus(emp.id, date);
        csv += `${status},`;
      });
      csv += `${stats.P},${stats.A},${stats.L},${stats.LV},${stats.SL},`;
      csv += `${deductions.absentDeduction},${deductions.lateDeduction},${deductions.lectureDeduction},${deductions.appearanceDeduction},${deductions.totalDeductions}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_${selectedMonth}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    logAudit({
      action: 'EXPORT',
      entity_type: 'attendance',
      new_data: { 
        month: selectedMonth,
        employeeCount: filteredEmployees.length
      },
      region_id: userProfile?.region_id
    });
    
    showNotification('Attendance report exported!', 'success');
  }, [filteredEmployees, dates, selectedMonth, userProfile, getEmployeeStats, calculateEmployeeDeductions, getAttendanceStatus]);

  // ===== COPY FROM PREVIOUS MONTH =====
  const copyFromPreviousMonth = useCallback(async (sourceMonth: string) => {
    const sourceDates = getDatesForMonth(sourceMonth);
    const targetDates = getDatesForMonth(selectedMonth);

    let sourceQuery = supabase
      .from('attendance')
      .select('*')
      .gte('date', sourceDates[0])
      .lte('date', sourceDates[sourceDates.length - 1]);
    
    if (!userProfile?.is_super_admin && userProfile?.region_id) {
      const { data: regionEmployees } = await supabase
        .from('employees')
        .select('id')
        .eq('region_id', userProfile.region_id)
        .eq('is_deleted', false);
      const employeeIds = regionEmployees?.map(e => e.id) || [];
      if (employeeIds.length > 0) {
        sourceQuery = sourceQuery.in('employee_id', employeeIds);
      }
    }
    
    const { data: sourceData, error: sourceError } = await sourceQuery;
    
    if (sourceError) {
      console.error('Error fetching source data:', sourceError);
      return;
    }
    
    if (sourceData && sourceData.length > 0) {
      // tenant_id is omitted -- it defaults to the current user's own tenant
      // via the DB column default, same convention as processSingleUpdate.
      const newRecords = sourceData.map(record => {
        const originalDate = new Date(record.date);
        const dayOfMonth = originalDate.getDate();
        return {
          employee_id: record.employee_id,
          date: targetDates[dayOfMonth - 1],
          status: record.status,
        };
      }).filter(record => record.date);

      const { error: insertError } = await supabase
        .from('attendance')
        .insert(newRecords);

      if (insertError) {
        console.error('Error copying data:', insertError);
        showNotification('Failed to copy data: ' + insertError.message, 'error');
      } else {
        await logAudit({
          action: 'CREATE',
          entity_type: 'attendance',
          new_data: {
            sourceMonth: sourceMonth,
            targetMonth: selectedMonth,
            recordsCopied: newRecords.length
          },
          region_id: userProfile?.region_id
        });

        await fetchData();
        showNotification(`Attendance data copied from ${getMonthLabel(sourceMonth)} to ${getMonthLabel(selectedMonth)}`, 'success');
        setShowCopyModal(false);
      }
    } else {
      showNotification('No attendance data found in the source month.', 'error');
    }
  }, [selectedMonth, userProfile, getDatesForMonth, fetchData]);

  // ===== EMPLOYEE MODAL =====
  const EmployeeModal = useCallback(() => {
    // All hooks below must run unconditionally, before the `if (!selectedEmployee)
    // return null` further down -- this function is invoked directly as
    // EmployeeModal() (not rendered as <EmployeeModal />), so its hook calls are
    // counted as part of AttendancePage's own render. Hooks used to be declared
    // AFTER that early return, so selecting an employee (or closing the modal
    // afterward) changed how many hooks got called between renders -- a Rules of
    // Hooks violation that crashes with "Rendered more hooks than during the
    // previous render" (React error #310) the moment you click any employee row.
    const [editableDeductions, setEditableDeductions] = useState({
      absentDays: 0,
      lateDays: 0,
      absentDeduction: 0,
      lateDeduction: 0,
      lectureMissed: 0,
      lectureDeduction: 0,
      appearanceDeduction: 0,
      totalDeductions: 0
    });
    const [saving, setSaving] = useState(false);
    const [savedSuccess, setSavedSuccess] = useState(false);

    useEffect(() => {
      if (!selectedEmployee) return;
      const newDeductions = calculateEmployeeDeductions(selectedEmployee.id);
      setEditableDeductions({
        absentDays: newDeductions.absentDays,
        lateDays: newDeductions.lateDays,
        absentDeduction: newDeductions.absentDeduction,
        lateDeduction: newDeductions.lateDeduction,
        lectureMissed: newDeductions.lectureMissedCount,
        lectureDeduction: newDeductions.lectureDeduction,
        appearanceDeduction: newDeductions.appearanceDeduction,
        totalDeductions: newDeductions.totalDeductions
      });
      setSavedSuccess(false);
    }, [selectedEmployee, attendance, calculateEmployeeDeductions]);

    const handleDeductionChange = (field: string, value: number) => {
      const safeValue = Math.max(0, Number(value) || 0);
      setEditableDeductions(prev => {
        const updated = { ...prev, [field]: safeValue };
        // Editing the Lectures Missed count previously had no effect on the
        // Lecture Deduction (MK) figure sitting right next to it -- an admin
        // bumping the count up or down would see the MK amount just stay
        // put, even though the two fields are presented as if one drives
        // the other. Recompute it the same way calculateEmployeeDeductions
        // does (flat full-month rate if every lecture this month was
        // missed, otherwise per-lecture), while still leaving Lecture
        // Deduction itself directly editable for a manual override.
        if (field === 'lectureMissed') {
          const totalLecturesThisMonth = getDatesForMonth(selectedMonth).filter(d => {
            const dayOfWeek = new Date(d).getDay();
            return dayOfWeek === 3 || dayOfWeek === 4;
          }).length;
          updated.lectureDeduction = safeValue === 0
            ? 0
            : safeValue === totalLecturesThisMonth
              ? deductionRates.lectureFullMonthDeduction
              : safeValue * deductionRates.lectureDeduction;
        }
        updated.totalDeductions =
          (updated.absentDeduction || 0) +
          (updated.lateDeduction || 0) +
          (updated.lectureDeduction || 0) +
          (updated.appearanceDeduction || 0);
        return updated;
      });
      setSavedSuccess(false);
    };

    const saveDeductions = async () => {
      if (!selectedEmployee) return;
      
      setSaving(true);
      try {
        const { data: existingRecord, error: checkError } = await supabase
          .from('employee_deductions')
          .select('*')
          .eq('employee_id', selectedEmployee.id)
          .eq('month', selectedMonth)
          .maybeSingle();

        if (checkError) throw checkError;

        const oldData = existingRecord ? {
          absent_days: existingRecord.absent_days || 0,
          late_days: existingRecord.late_days || 0,
          absent_deduction: existingRecord.absent_deduction || 0,
          late_deduction: existingRecord.late_deduction || 0,
          lecture_missed: existingRecord.lecture_missed || 0,
          lecture_deduction: existingRecord.lecture_deduction || 0,
          appearance_deduction: existingRecord.appearance_deduction || 0,
          total_deductions: existingRecord.total_deductions || 0
        } : null;

        const deductionData = {
          employee_id: selectedEmployee.id,
          month: selectedMonth,
          absent_days: editableDeductions.absentDays,
          late_days: editableDeductions.lateDays,
          absent_deduction: editableDeductions.absentDeduction,
          late_deduction: editableDeductions.lateDeduction,
          lecture_missed: editableDeductions.lectureMissed,
          lecture_deduction: editableDeductions.lectureDeduction,
          appearance_deduction: editableDeductions.appearanceDeduction,
          total_deductions: editableDeductions.totalDeductions,
          updated_at: new Date().toISOString()
        };

        let result;
        if (existingRecord) {
          result = await supabase
            .from('employee_deductions')
            .update(deductionData)
            .eq('id', existingRecord.id);
        } else {
          result = await supabase
            .from('employee_deductions')
            .insert([{
              ...deductionData,
              created_at: new Date().toISOString()
            }]);
        }

        if (result.error) throw result.error;

        await logAudit({
          action: existingRecord ? 'UPDATE' : 'CREATE',
          entity_type: 'employee_deductions',
          entity_id: existingRecord?.id || selectedEmployee.id,
          old_data: oldData,
          new_data: deductionData,
          region_id: userProfile?.region_id
        });

        setSavedSuccess(true);
        showNotification(`Deductions saved for ${selectedEmployee.full_name}`, 'success');
        await fetchData();
        setTimeout(() => {
          setSelectedEmployee(null);
        }, 2000);
      } catch (err: any) {
        console.error('Error saving deductions:', err);
        showNotification('Failed to save deductions: ' + err.message, 'error');
      } finally {
        setSaving(false);
      }
    };

    const loadSavedDeductions = async () => {
      if (!selectedEmployee) return;
      
      try {
        const { data, error } = await supabase
          .from('employee_deductions')
          .select('*')
          .eq('employee_id', selectedEmployee.id)
          .eq('month', selectedMonth)
          .maybeSingle();

        if (error) throw error;

        if (data) {
          setEditableDeductions({
            absentDays: data.absent_days || 0,
            lateDays: data.late_days || 0,
            absentDeduction: data.absent_deduction || 0,
            lateDeduction: data.late_deduction || 0,
            lectureMissed: data.lecture_missed || 0,
            lectureDeduction: data.lecture_deduction || 0,
            appearanceDeduction: data.appearance_deduction || 0,
            totalDeductions: data.total_deductions || 0
          });
          setSavedSuccess(true);
        }
      } catch (err) {
        console.error('Error loading saved deductions:', err);
      }
    };

    useEffect(() => {
      if (selectedEmployee) {
        loadSavedDeductions();
      }
    }, [selectedEmployee]);

    if (!selectedEmployee) return null;
    const stats = getEmployeeStats(selectedEmployee.id);

    return (
      <Modal open={!!selectedEmployee} onClose={() => setSelectedEmployee(null)} title="Attendance & Deductions Summary" size="xl">
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-[#081C3A] text-white text-lg font-bold flex items-center justify-center">
              {selectedEmployee.full_name?.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
            </div>
            <div>
              <h3 className="font-bold text-slate-800">{selectedEmployee.full_name}</h3>
              <p className="text-sm text-slate-500">{selectedEmployee.position} · {selectedEmployee.employee_number}</p>
              {savedSuccess && (
                <Badge color="green" className="mt-1">✓ Saved</Badge>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="p-3 bg-emerald-50 rounded-lg flex justify-between items-center">
              <span className="text-sm">Present</span>
              <span className="font-bold text-emerald-600">{stats.P} days</span>
            </div>
            <div className="p-3 bg-red-50 rounded-lg flex justify-between items-center">
              <span className="text-sm">Absent</span>
              <span className="font-bold text-red-600">{stats.A} days</span>
            </div>
            <div className="p-3 bg-yellow-50 rounded-lg flex justify-between items-center">
              <span className="text-sm">Late</span>
              <span className="font-bold text-yellow-600">{stats.L} days</span>
            </div>
            <div className="p-3 bg-blue-50 rounded-lg flex justify-between items-center">
              <span className="text-sm">Leave</span>
              <span className="font-bold text-blue-600">{stats.LV} days</span>
            </div>
            <div className="p-3 bg-purple-50 rounded-lg flex justify-between items-center">
              <span className="text-sm">Sick</span>
              <span className="font-bold text-purple-600">{stats.SL} days</span>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-semibold text-slate-800">Deductions Summary</h4>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  onClick={loadSavedDeductions}
                  disabled={saving}
                  size="sm"
                >
                  <RefreshCw size={14} className="mr-1" /> Reload
                </Button>
                <Button 
                  variant="secondary" 
                  onClick={saveDeductions}
                  disabled={saving || savedSuccess}
                >
                  {saving ? (
                    <span className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Saving...
                    </span>
                  ) : savedSuccess ? (
                    '✓ Saved'
                  ) : (
                    'Save Deductions'
                  )}
                </Button>
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 bg-slate-50 rounded-lg">
                <p className="text-xs text-slate-400 mb-2">
                  Counted automatically from this month's attendance record -- Payroll
                  uses these live, so they're no longer editable here.
                </p>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-slate-700">Absent Days</label>
                    <input
                      type="number"
                      value={editableDeductions.absentDays}
                      disabled
                      className="w-20 px-2 py-1 text-sm border border-slate-200 rounded text-right bg-slate-100 text-slate-500 cursor-not-allowed"
                      min="0"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-slate-700">Absent Deduction (MK)</label>
                    <input
                      type="number"
                      value={editableDeductions.absentDeduction}
                      disabled
                      className="w-28 px-2 py-1 text-sm border border-slate-200 rounded text-right bg-slate-100 text-slate-500 cursor-not-allowed"
                      min="0"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-slate-700">Late Days</label>
                    <input
                      type="number"
                      value={editableDeductions.lateDays}
                      disabled
                      className="w-20 px-2 py-1 text-sm border border-slate-200 rounded text-right bg-slate-100 text-slate-500 cursor-not-allowed"
                      min="0"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-slate-700">Late Deduction (MK)</label>
                    <input
                      type="number"
                      value={editableDeductions.lateDeduction}
                      disabled
                      className="w-28 px-2 py-1 text-sm border border-slate-200 rounded text-right bg-slate-100 text-slate-500 cursor-not-allowed"
                      min="0"
                    />
                  </div>
                </div>
              </div>

              <div className="p-4 bg-slate-50 rounded-lg">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-slate-700">Lectures Missed</label>
                    <input
                      type="number"
                      value={editableDeductions.lectureMissed}
                      onChange={(e) => handleDeductionChange('lectureMissed', parseInt(e.target.value) || 0)}
                      className="w-20 px-2 py-1 text-sm border border-slate-200 rounded text-right"
                      min="0"
                    />
                    <span className="text-xs text-slate-400">(Wed/Thu)</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-slate-700">Lecture Deduction (MK)</label>
                    <input
                      type="number"
                      value={editableDeductions.lectureDeduction}
                      onChange={(e) => handleDeductionChange('lectureDeduction', parseInt(e.target.value) || 0)}
                      className="w-28 px-2 py-1 text-sm border border-slate-200 rounded text-right"
                      min="0"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-slate-700">Appearance/Hygiene (MK)</label>
                    <input
                      type="number"
                      value={editableDeductions.appearanceDeduction}
                      onChange={(e) => handleDeductionChange('appearanceDeduction', parseInt(e.target.value) || 0)}
                      className="w-28 px-2 py-1 text-sm border border-slate-200 rounded text-right"
                      min="0"
                    />
                  </div>
                  <div className="flex items-center justify-between pt-3 border-t border-slate-200">
                    <span className="font-semibold text-slate-800">Total Deductions</span>
                    <span className="font-bold text-red-600 text-lg">
                      MK {editableDeductions.totalDeductions.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 p-3 bg-amber-50 rounded-lg border border-amber-200">
              <p className="text-xs text-amber-700 flex items-center gap-2">
                <Scissors size={14} />
                <strong>Note:</strong> Appearance deduction (MK 2,000) is applied monthly for uniform cleaning, shaving, and keeping hair short and smart. 
                Lecture deductions (MK 3,000 each) apply for missed Wednesday/Thursday lectures. Full month absence from lectures incurs MK 15,000 deduction.
              </p>
            </div>
          </div>
        </div>
      </Modal>
    );
  }, [selectedEmployee, getEmployeeStats, calculateEmployeeDeductions, selectedMonth, userProfile, fetchData, getDatesForMonth]);

  // ===== RENDER =====
  // EmployeeModal() must be called unconditionally, before the loading/error
  // early returns below -- it's invoked as a plain function (not <EmployeeModal
  // />), so its internal hooks are counted as part of THIS component's own
  // render. `loading` starts true and flips to false right after the initial
  // fetch, so calling EmployeeModal() only in the branch reached after those
  // early returns meant the very first render skipped its 4 hooks entirely
  // while every later render called them -- a Rules of Hooks violation
  // ("Rendered more hooks than during the previous render", React error #310)
  // that fired on every visit to this page, right as the initial load finished.
  const employeeModal = EmployeeModal();

  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div></div>;
  }

  if (error) {
    return <div className="text-center py-12 text-red-500">{error}</div>;
  }

  const totalPages = Math.ceil(filteredEmployees.length / attendanceItemsPerPage);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Attendance Management"
        subtitle={isSuperAdmin ? "Monthly attendance tracker for all security personnel" : `${userRegion?.name || ''} Region - Attendance Tracker`}
        actions={
          <div className="flex gap-2">
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2 py-1">
              <button
                onClick={goToPreviousMonth}
                className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getPreviousMonth(selectedMonth))}
                title="Previous Month"
              >
                <ChevronLeft size={16} />
              </button>
              
              <select
                value={selectedMonth}
                onChange={(e) => handleMonthSelect(e.target.value)}
                className="bg-transparent border-none text-sm font-medium text-slate-700 focus:ring-0 py-1 min-w-[140px] text-center cursor-pointer"
              >
                {availableMonths.map((month, index) => (
                  <option key={`month-${month}-${index}`} value={month}>
                    {getMonthLabel(month)} {month === systemMonth ? '●' : ''}
                  </option>
                ))}
              </select>
              
              <button
                onClick={goToNextMonth}
                className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
                disabled={loading || !availableMonths.includes(getNextMonth(selectedMonth))}
                title="Next Month"
              >
                <ChevronRight size={16} />
              </button>
            </div>

            {!isCurrentMonth && (
              <button
                onClick={goToCurrentMonth}
                className="text-xs text-[#D4A017] hover:underline px-2 py-1"
              >
                Jump to Current
              </button>
            )}

            <Button variant="secondary" onClick={exportReport}><FileText size={16} /> Export Report</Button>
          </div>
        }
      />

      {!isCurrentMonth && (
        <Card className={`p-3 border ${isFutureMonthSelected ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-start gap-3">
            <Calendar size={18} className={`shrink-0 mt-0.5 ${isFutureMonthSelected ? 'text-blue-600' : 'text-amber-600'}`} />
            <div>
              <p className={`text-sm font-medium ${isFutureMonthSelected ? 'text-blue-800' : 'text-amber-800'}`}>
                {isFutureMonthSelected ? 'Viewing Future Month' : 'Viewing Past Month'}
              </p>
              <p className={`text-sm ${isFutureMonthSelected ? 'text-blue-700' : 'text-amber-700'}`}>
                {isFutureMonthSelected 
                  ? 'You are viewing a future month. Attendance can only be edited for the current month.' 
                  : 'You are viewing a past month. Attendance can only be edited for the current month.'}
                {!isCurrentMonth && (
                  <button 
                    onClick={goToCurrentMonth}
                    className="ml-2 text-[#D4A017] hover:underline font-medium"
                  >
                    Switch to {getMonthLabel(systemMonth)}
                  </button>
                )}
              </p>
            </div>
          </div>
        </Card>
      )}

      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Viewing attendance for <strong className="text-[#081C3A]">{userRegion.name}</strong> region
          </p>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-5"><div className="flex items-center justify-between"><div><p className="text-xs text-slate-500">Attendance Rate</p><p className="text-2xl font-bold text-slate-800 mt-1">{metrics.attendanceRate}%</p><Badge color={parseFloat(metrics.attendanceRate) > 80 ? 'green' : parseFloat(metrics.attendanceRate) > 60 ? 'yellow' : 'red'}>↑ {parseFloat(metrics.attendanceRate) > 80 ? 'Excellent' : parseFloat(metrics.attendanceRate) > 60 ? 'Good' : 'Needs Improvement'}</Badge></div><div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center"><CheckCircle2 size={22} /></div></div></Card>
        <Card className="p-5"><div className="flex items-center justify-between"><div><p className="text-xs text-slate-500">Absenteeism</p><p className="text-2xl font-bold text-slate-800 mt-1">{metrics.absenteeism}%</p><Badge color={parseFloat(metrics.absenteeism) < 20 ? 'green' : parseFloat(metrics.absenteeism) < 40 ? 'yellow' : 'red'}>Manageable</Badge></div><div className="w-12 h-12 rounded-xl bg-red-100 text-red-600 flex items-center justify-center"><XCircle size={22} /></div></div></Card>
        <Card className="p-5"><div className="flex items-center justify-between"><div><p className="text-xs text-slate-500">Late Arrivals</p><p className="text-2xl font-bold text-slate-800 mt-1">{metrics.late}</p><p className="text-xs text-slate-500 mt-1">this month</p></div><div className="w-12 h-12 rounded-xl bg-[#FFF1CC] text-[#D4A017] flex items-center justify-center"><Clock size={22} /></div></div></Card>
        <Card className="p-5"><div className="flex items-center justify-between"><div><p className="text-xs text-slate-500">Leave Days</p><p className="text-2xl font-bold text-slate-800 mt-1">{metrics.leaveRequests}</p><p className="text-xs text-slate-500 mt-1">this month</p></div><div className="w-12 h-12 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center"><Plane size={22} /></div></div></Card>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-4 text-xs">
          {Object.keys(statusColors).filter(k => k !== '-').map(k => (<div key={k} className="flex items-center gap-2"><span className={`w-4 h-4 rounded ${statusColors[k]}`} /><span className="text-slate-700">{statusLabels[k]}</span></div>))}
          <div className="flex items-center gap-2"><span className="w-4 h-4 rounded bg-slate-200" /><span className="text-slate-700">Weekend / Off</span></div>
          <div className="ml-auto text-xs text-slate-400">Click on any status to change (cycles through all options)</div>
        </div>
      </Card>

      <Card className="p-4 flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input 
            id="searchAttendance"
            name="searchAttendance"
            type="text"
            value={search} 
            onChange={e => setSearch(sanitizeInput(e.target.value))} 
            placeholder="Search employees..." 
            className="w-full pl-10 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          />
        </div>
        <div className="text-sm text-slate-500">{filteredEmployees.length} employees</div>
        {!isCurrentMonth && (
          <Badge color={isFutureMonthSelected ? 'blue' : 'amber'} className="text-xs">
            {isFutureMonthSelected ? '🔮 View Only' : '📅 View Only'}
          </Badge>
        )}
      </Card>

      {!hasData && isCurrentMonth && (
        <EmptyState
          title="No Attendance Records Yet"
          message={`No attendance has been recorded for ${getMonthLabel(selectedMonth)} yet.`}
          actionLabel={availableMonths.filter(m => m < selectedMonth).length > 0 ? "Copy from Previous Month" : ""}
          onAction={() => setShowCopyModal(true)}
        />
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <THead>
              <TR hover={false}>
                <TH className="sticky left-0 bg-[#F8FAFC] z-10">Employee</TH>
                <TH className="hidden md:table-cell">Position</TH>
                {dates.map((_, i) => (<TH key={i} className="text-center text-[10px]">{i + 1}</TH>))}
                <TH className="text-center bg-emerald-50">P</TH>
                <TH className="text-center bg-red-50">A</TH>
                <TH className="text-center bg-yellow-50">L</TH>
                <TH className="text-center">Total</TH>
              </TR>
            </THead>
            <TBody>
              {paginatedEmployees.map(emp => {
                const stats = getEmployeeStats(emp.id);
                const isEditable = isCurrentMonth;
                return (
                  <TR key={emp.id} onClick={() => setSelectedEmployee(emp)} className="cursor-pointer">
                    <TD className="sticky left-0 bg-white z-10">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-[#081C3A] text-white text-[10px] font-bold flex items-center justify-center">
                          {emp.full_name?.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-800">{emp.full_name}</p>
                          <p className="text-[10px] text-slate-500">{emp.employee_number}</p>
                          {emp.status !== 'Active' && (
                            <Badge color={emp.status === 'On Leave' ? 'yellow' : 'red'} className="text-[8px] mt-0.5">
                              {emp.status}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </TD>
                    <TD className="hidden md:table-cell text-xs">{emp.position}</TD>
                    {dates.map((date, i) => {
                      const status = getAttendanceStatus(emp.id, date);
                      const updateKey = `${emp.id}-${date}`;
                      const isUpdating = updating[updateKey];
                      return (
                        <td key={i} className="px-1 py-3 text-center" onClick={(e) => { 
                          e.stopPropagation(); 
                          if (isEditable && !isUpdating) {
                            getDebouncedUpdate(updateKey)(emp.id, date, status);
                          } else if (!isEditable) {
                            showNotification('Attendance can only be edited for the current month.', 'info');
                          }
                        }}>
                          <div className={`w-6 h-6 mx-auto rounded text-[10px] font-semibold text-white flex items-center justify-center ${!isEditable ? 'cursor-not-allowed opacity-70' : isUpdating ? 'opacity-50' : 'cursor-pointer hover:opacity-80'} transition-opacity ${statusColors[status]}`}>
                            {isUpdating ? (
                              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            ) : (
                              status
                            )}
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-center font-semibold text-emerald-700 bg-emerald-50/50">{stats.P}</td>
                    <td className="px-4 py-3 text-center font-semibold text-red-700 bg-red-50/50">{stats.A}</td>
                    <td className="px-4 py-3 text-center font-semibold text-yellow-700 bg-yellow-50/50">{stats.L}</td>
                    <td className="px-4 py-3 text-center font-bold text-slate-800">{stats.total} days</td>
                  </TR>
                );
              })}
            </TBody>
          </table>
        </div>
      </div>

      <Pagination
        currentPage={attendancePage}
        totalPages={totalPages}
        totalItems={filteredEmployees.length}
        itemsPerPage={attendanceItemsPerPage}
        onPageChange={setAttendancePage}
        onItemsPerPageChange={setAttendanceItemsPerPage}
      />

      {/* Called as a plain function, not <EmployeeModal />: this "component" is
          a useCallback closure so it can capture selectedEmployee/attendance
          directly. Rendering it as JSX would make React treat every identity
          change of that callback as a brand-new component type and remount
          the modal (losing the in-progress lecture/appearance deduction
          edits) any time attendance data changes elsewhere on the page. */}
      {employeeModal}
      <CopyFromPreviousModal
        open={showCopyModal}
        onClose={() => setShowCopyModal(false)}
        onConfirm={copyFromPreviousMonth}
        currentMonth={selectedMonth}
        availableMonths={availableMonths.filter(m => m < selectedMonth)}
      />
    </div>
  );
}

export default AttendancePage;