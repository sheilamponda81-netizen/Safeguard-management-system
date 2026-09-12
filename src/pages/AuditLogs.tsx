import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Download,
  Eye,
  Activity,
  User,
  Clock,
  Calendar,
  RefreshCw,
} from "lucide-react";
import {
  Card,
  Button,
  Badge,
  PageHeader,
  Modal,
} from "../components/ui";
import { supabase } from "../lib/supabase";
import { showNotification } from "../utils/clickHandlers";
import { toCsvRow } from "../utils/csvExport";
import { UserProfile } from "../utils/currentProfile";

// Raw `audit_logs` row shape (query below is `select('*')`). `old_data`/
// `new_data` stay `unknown` -- they're a generic per-entity_type payload
// (see auditLogger.ts), only ever displayed via JSON.stringify or diffed
// key-by-key here, never assumed to have a fixed shape.
interface AuditLogRow {
  id: string;
  user_id: string | null;
  user_email: string | null;
  user_role: string | null;
  region_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  old_data: unknown;
  new_data: unknown;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  // Not a real column -- added client-side below (see fetchAuditLogs)
  // by looking `region_id` up in the fetched `regions` Map.
  region_name?: string | null;
}

// Loose shape covering every field the detail-modal's per-entity_type/
// action panels below read out of old_data/new_data (LOGIN, attendance,
// payment_status, ...). Each panel is already gated by a real
// entity_type/action check at render time, so casting old_data/new_data to
// this shape there reflects what that runtime check guarantees, not a
// blind assumption -- these payloads are still genuinely variable per
// entity_type (see auditLogger.ts), so no single named interface fits.
interface AuditPayloadFields {
  success?: boolean;
  email?: string;
  full_name?: string;
  role_level?: number;
  is_super_admin?: boolean;
  region_name?: string;
  error?: string;
  status?: string;
  employee_name?: string;
  employee_number?: string;
  date?: string;
  month?: string;
  payment_date?: string;
  account_number?: string;
  transaction_id?: string;
  notes?: string;
}

export function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterAction, setFilterAction] = useState("all");
  const [filterEntity, setFilterEntity] = useState("all");
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [selectedLog, setSelectedLog] = useState<AuditLogRow | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [regions, setRegions] = useState<Map<string, string>>(new Map());

  const actions = [
    "all",
    "CREATE",
    "UPDATE",
    "DELETE",
    "LOGIN",
    "LOGOUT",
    "EXPORT",
    "VIEW",
    "APPROVE",
    "REJECT",
  ];
  const entities = [
    "all",
    "auth",
    "employee",
    "attendance",
    "applicant",
    "user",
    "role",
    "payroll",
    "payment_status",
    "employee_deductions",
    "profiles",
  ];

  // Status labels for attendance
  const statusLabels: Record<string, string> = {
    P: "Present",
    A: "Absent",
    L: "Late",
    LV: "Leave",
    SL: "Sick",
    "-": "Off",
  };

  // Status labels for payment
  const paymentStatusLabels: Record<string, string> = {
    pending: "Pending",
    processing: "Processing",
    paid: "Paid",
    confirmed: "Confirmed",
    failed: "Failed",
  };

  // Pay point labels
  const payPointLabels: Record<string, string> = {
    national_bank: "National Bank",
    standard_bank: "Standard Bank",
    nbs_bank: "NBS Bank",
    centenary_bank: "Centenary Bank",
    fdh_bank: "FDH Bank",
    first_capital_bank: "First Capital Bank",
    airtel_money: "Airtel Money",
    tnm_mpamba: "TNM Mpamba",
  };

  // Fetch regions for mapping
  useEffect(() => {
    const fetchRegions = async () => {
      const { data } = await supabase.from("regions").select("id, name");
      if (data) {
        const regionMap = new Map<string, string>();
        data.forEach((r: { id: string; name: string }) => regionMap.set(r.id, r.name));
        setRegions(regionMap);
      }
    };
    fetchRegions();
  }, []);

  useEffect(() => {
    const fetchUserProfile = async () => {
      setUserLoading(true);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("*, regions(*)")
          .eq("id", user.id)
          .single();
        setUserProfile(profile);
      }
      setUserLoading(false);
    };
    fetchUserProfile();
  }, []);

  const fetchAuditLogs = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);

      if (filterAction !== "all") {
        query = query.eq("action", filterAction);
      }
      if (filterEntity !== "all") {
        query = query.eq("entity_type", filterEntity);
      }

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        query = query.eq("region_id", userProfile.region_id);
      }

      const { data, error } = await query;
      if (error) throw error;
      
      // Add region names to logs
      const logsWithRegion = (data || []).map((log: AuditLogRow) => ({
        ...log,
        region_name: log.region_id ? regions.get(log.region_id) || null : null
      }));

      setLogs(logsWithRegion);
    } catch (err) {
      console.error("Error fetching audit logs:", err);
      showNotification("Failed to load audit logs", "error");
    } finally {
      setLoading(false);
    }
  }, [filterAction, filterEntity, userProfile, regions]);

  useEffect(() => {
    if (userProfile) {
      fetchAuditLogs();
    }
  }, [userProfile, filterAction, filterEntity, fetchAuditLogs]);

  const getActionBadgeColor = (action: string) => {
    switch (action) {
      case "CREATE":
        return "green";
      case "UPDATE":
        return "blue";
      case "DELETE":
        return "red";
      case "LOGIN":
        return "emerald";
      case "LOGOUT":
        return "gray";
      case "EXPORT":
        return "gold";
      case "VIEW":
        return "cyan";
      case "APPROVE":
        return "green";
      case "REJECT":
        return "orange";
      default:
        return "gray";
    }
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case "CREATE":
        return "➕";
      case "UPDATE":
        return "✏️";
      case "DELETE":
        return "🗑️";
      case "LOGIN":
        return "🔐";
      case "LOGOUT":
        return "🚪";
      case "EXPORT":
        return "📊";
      case "VIEW":
        return "👁️";
      case "APPROVE":
        return "✅";
      case "REJECT":
        return "❌";
      default:
        return "📋";
    }
  };

  // Helper to format attendance data
  const formatAttendanceData = (data: Record<string, unknown>) => {
    if (!data) return null;
    const formatted: Record<string, unknown> = {};

    if (data.status) {
      formatted.Status = statusLabels[String(data.status)] || data.status;
    }
    if (data.employee_id) {
      formatted.Employee = data.employee_name || data.employee_id;
    }
    if (data.date) {
      formatted.Date = new Date(String(data.date)).toLocaleDateString();
    }
    if (data.employee_name) {
      formatted.Employee = data.employee_name;
    }
    if (data.employee_number) {
      formatted["Employee #"] = data.employee_number;
    }

    // Copy any remaining fields
    Object.keys(data).forEach(key => {
      if (!['status', 'employee_id', 'date', 'employee_name', 'employee_number'].includes(key)) {
        formatted[key] = data[key];
      }
    });

    return formatted;
  };

  // Helper to format payment data
  const formatPaymentData = (data: Record<string, unknown>) => {
    if (!data) return null;
    const formatted: Record<string, unknown> = {};

    if (data.status) {
      formatted.Status = paymentStatusLabels[String(data.status)] || data.status;
    }
    if (data.employee_name) {
      formatted.Employee = data.employee_name;
    }
    if (data.employee_number) {
      formatted["Employee #"] = data.employee_number;
    }
    if (data.pay_point) {
      formatted["Pay Point"] = payPointLabels[String(data.pay_point)] || data.pay_point;
    }
    if (data.amount) {
      formatted.Amount = `MK ${Number(data.amount).toLocaleString()}`;
    }
    if (data.net_pay) {
      formatted["Net Pay"] = `MK ${Number(data.net_pay).toLocaleString()}`;
    }
    if (data.payment_date) {
      formatted["Payment Date"] = new Date(String(data.payment_date)).toLocaleDateString();
    }
    if (data.month) {
      const [year, month] = String(data.month).split('-');
      formatted.Month = new Date(parseInt(year), parseInt(month) - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
    }
    if (data.account_number) {
      formatted["Account Number"] = data.account_number;
    }
    if (data.transaction_id) {
      formatted["Transaction ID"] = data.transaction_id;
    }
    if (data.notes) {
      formatted.Notes = data.notes;
    }

    // Copy any remaining fields
    Object.keys(data).forEach(key => {
      if (!['status', 'employee_name', 'employee_number', 'pay_point', 'amount', 'net_pay', 'payment_date', 'month', 'account_number', 'transaction_id', 'notes'].includes(key)) {
        formatted[key] = data[key];
      }
    });

    return formatted;
  };

  // Helper to format employee data
  const formatEmployeeData = (data: Record<string, unknown>) => {
    if (!data) return null;
    const formatted: Record<string, unknown> = {};

    if (data.full_name) {
      formatted["Full Name"] = data.full_name;
    }
    if (data.employee_number) {
      formatted["Employee #"] = data.employee_number;
    }
    if (data.position) {
      formatted.Position = data.position;
    }
    if (data.department) {
      formatted.Department = data.department;
    }
    if (data.company) {
      formatted.Company = data.company;
    }
    if (data.workstation) {
      formatted.Workstation = data.workstation;
    }
    if (data.basic_salary) {
      formatted["Basic Salary"] = `MK ${Number(data.basic_salary).toLocaleString()}`;
    }
    if (data.phone) {
      formatted.Phone = data.phone;
    }
    if (data.email) {
      formatted.Email = data.email;
    }
    if (data.status) {
      formatted.Status = data.status;
    }

    return formatted;
  };

  // Main formatter that routes to the right formatter based on entity type
  const formatEntityData = (entityType: string | null, data: Record<string, unknown>) => {
    if (!data) return null;
    
    switch (entityType) {
      case 'attendance':
        return formatAttendanceData(data);
      case 'payment_status':
        return formatPaymentData(data);
      case 'employee':
      case 'employees':
        return formatEmployeeData(data);
      default:
        return data;
    }
  };

  // Render formatted data in a nice way
  const renderFormattedData = (entityType: string | null, data: unknown, title: string) => {
    if (!data || typeof data !== "object" || Object.keys(data).length === 0) return null;

    const formatted = formatEntityData(entityType, data as Record<string, unknown>);
    if (!formatted) return null;
    
    return (
      <div>
        <p className="text-slate-500 text-xs mb-2">{title}</p>
        <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {Object.entries(formatted).map(([key, value]) => (
              <div key={key} className="flex items-start gap-2">
                <span className="text-xs font-medium text-slate-600 min-w-[100px]">{key}:</span>
                <span className="text-xs text-slate-800 break-all">{String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const filteredLogs = logs.filter(
    (log) =>
      log.user_email?.toLowerCase().includes(search.toLowerCase()) ||
      log.action?.toLowerCase().includes(search.toLowerCase()) ||
      log.entity_type?.toLowerCase().includes(search.toLowerCase()) ||
      log.entity_id?.toLowerCase().includes(search.toLowerCase()) ||
      log.region_name?.toLowerCase().includes(search.toLowerCase())
  );

  const exportLogs = () => {
    if (filteredLogs.length === 0) {
      showNotification("No logs to export", "error");
      return;
    }

    const headers = ["Date", "User", "Action", "Entity Type", "Entity ID", "Region", "Changes"];
    const rows = filteredLogs.map((log) => [
      new Date(log.created_at).toLocaleString(),
      log.user_email || "System",
      log.action,
      log.entity_type,
      log.entity_id || "-",
      log.region_name || "N/A",
      JSON.stringify(log.new_data || log.old_data || {}),
    ]);

    const csv = [headers, ...rows].map(toCsvRow).join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit_logs_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification(`Exported ${filteredLogs.length} logs`, "success");
  };

  const refreshLogs = () => {
    fetchAuditLogs();
    showNotification("Logs refreshed", "info");
  };

  // Format timestamp nicely
  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return {
      date: date.toLocaleDateString(),
      time: date.toLocaleTimeString(),
      full: date.toLocaleString()
    };
  };

  // Check if user is super admin
  const isSuperAdmin = userProfile?.is_super_admin;

  if (userLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <div className="text-center py-12">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
          <Activity size={32} className="text-red-500" />
        </div>
        <h2 className="text-xl font-semibold text-slate-800 mb-2">
          Access Denied
        </h2>
        <p className="text-slate-500">
          Only Super Administrators can view audit logs.
        </p>
        <p className="text-slate-400 text-sm mt-2">
          Please contact your system administrator.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Audit Logs"
        subtitle="Track all user actions and system changes"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={refreshLogs}>
              <RefreshCw size={16} className="mr-1" /> Refresh
            </Button>
            <Button variant="secondary" onClick={exportLogs}>
              <Download size={16} className="mr-1" /> Export Logs
            </Button>
          </div>
        }
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
              <Activity size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">Total Actions</p>
              <p className="text-xl font-bold text-slate-800">{logs.length}</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <User size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">Active Users</p>
              <p className="text-xl font-bold text-slate-800">
                {new Set(logs.map((l) => l.user_email)).size}
              </p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center">
              <Clock size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">Today's Activity</p>
              <p className="text-xl font-bold text-slate-800">
                {
                  logs.filter(
                    (l) =>
                      new Date(l.created_at).toDateString() ===
                      new Date().toDateString()
                  ).length
                }
              </p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#FFF1CC] text-[#D4A017] flex items-center justify-center">
              <Calendar size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">This Month</p>
              <p className="text-xl font-bold text-slate-800">
                {
                  logs.filter(
                    (l) =>
                      new Date(l.created_at).getMonth() ===
                      new Date().getMonth()
                  ).length
                }
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="relative md:col-span-2">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by user, action, entity, region..."
              className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
            />
          </div>
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          >
            {actions.map((a) => (
              <option key={a} value={a}>
                {a === "all" ? "All Actions" : a}
              </option>
            ))}
          </select>
          <select
            value={filterEntity}
            onChange={(e) => setFilterEntity(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          >
            {entities.map((e) => (
              <option key={e} value={e}>
                {e === "all" ? "All Entities" : e.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F8FAFC] border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Timestamp</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">User</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Action</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Entity</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Region</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Details</th>
                <th className="px-4 py-3 text-right font-semibold text-slate-600">View</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredLogs.slice(0, 100).map((log) => {
                const time = formatTimestamp(log.created_at);
                return (
                  <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-xs">
                        {time.date}
                        <br />
                        <span className="text-slate-400 text-[10px]">
                          {time.time}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-slate-800">
                        {log.user_email?.split("@")[0] || "System"}
                      </div>
                      <div className="text-xs text-slate-400 capitalize">
                        {log.user_role || "user"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge color={getActionBadgeColor(log.action)}>
                        {getActionIcon(log.action)} {log.action}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-mono text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                        {log.entity_type || "unknown"}
                      </span>
                      {log.entity_id && (
                        <div className="text-[10px] text-slate-400 truncate max-w-[120px] mt-0.5">
                          ID: {log.entity_id.slice(0, 8)}...
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium text-slate-700">
                        {log.region_name || "N/A"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {typeof log.new_data === "object" && log.new_data !== null && Object.keys(log.new_data).length > 0 && (
                        <div className="text-xs text-slate-600 truncate max-w-[150px]">
                          {Object.keys(log.new_data).slice(0, 2).join(", ")}
                          {Object.keys(log.new_data).length > 2 &&
                            ` +${Object.keys(log.new_data).length - 2}`}
                        </div>
                      )}
                      {!log.new_data && typeof log.old_data === "object" && log.old_data !== null && Object.keys(log.old_data).length > 0 && (
                        <div className="text-xs text-slate-400 truncate max-w-[150px]">
                          Changed data
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-600 transition-colors"
                      >
                        <Eye size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredLogs.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            <Activity size={32} className="mx-auto mb-2 text-slate-300" />
            <p>No audit logs found</p>
            <p className="text-xs text-slate-400 mt-1">
              Try adjusting your filters or refresh the page
            </p>
          </div>
        ) : (
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-500 flex justify-between">
            <span>Showing {Math.min(100, filteredLogs.length)} of {filteredLogs.length} logs</span>
            <span>Total Records: {filteredLogs.length}</span>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      <Modal
        open={!!selectedLog}
        onClose={() => setSelectedLog(null)}
        title="Audit Log Details"
        size="lg"
      >
        {selectedLog && (() => {
          const oldData = selectedLog.old_data as AuditPayloadFields | null | undefined;
          const newData = selectedLog.new_data as AuditPayloadFields | null | undefined;
          return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-slate-500 text-xs">Timestamp</p>
                <p className="font-medium">
                  {new Date(selectedLog.created_at).toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-slate-500 text-xs">User</p>
                <p className="font-medium">{selectedLog.user_email || "System"}</p>
                <p className="text-xs text-slate-400 capitalize">Role: {selectedLog.user_role || "user"}</p>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Action</p>
                <Badge color={getActionBadgeColor(selectedLog.action)}>
                  {getActionIcon(selectedLog.action)} {selectedLog.action}
                </Badge>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Region</p>
                <p className="font-medium">{selectedLog.region_name || "N/A"}</p>
                {selectedLog.region_id && (
                  <p className="text-xs text-slate-400 truncate">ID: {selectedLog.region_id}</p>
                )}
              </div>
              <div className="col-span-2">
                <p className="text-slate-500 text-xs">Entity</p>
                <p className="font-mono text-sm">
                  {selectedLog.entity_type || "unknown"}
                </p>
                {selectedLog.entity_id && (
                  <p className="text-xs text-slate-400">ID: {selectedLog.entity_id}</p>
                )}
              </div>
            </div>

            {/* Show login details specially */}
            {selectedLog.action === "LOGIN" && newData && (
              <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-xs text-blue-700 font-semibold mb-2">🔐 Login Details</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-slate-500">Status:</span>
                    <span className={`ml-2 font-semibold ${newData.success ? 'text-green-600' : 'text-red-600'}`}>
                      {newData.success ? '✅ Success' : '❌ Failed'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Email:</span>
                    <span className="ml-2">{newData.email || 'N/A'}</span>
                  </div>
                  {newData.full_name && (
                    <div>
                      <span className="text-slate-500">Name:</span>
                      <span className="ml-2">{newData.full_name}</span>
                    </div>
                  )}
                  {newData.role_level !== undefined && (
                    <div>
                      <span className="text-slate-500">Role Level:</span>
                      <span className="ml-2">{newData.role_level}</span>
                    </div>
                  )}
                  {newData.is_super_admin !== undefined && (
                    <div className="col-span-2">
                      <span className="text-slate-500">Super Admin:</span>
                      <span className="ml-2">{newData.is_super_admin ? '✅ Yes' : '❌ No'}</span>
                    </div>
                  )}
                  {newData.region_name && (
                    <div className="col-span-2">
                      <span className="text-slate-500">Region:</span>
                      <span className="ml-2">{newData.region_name}</span>
                    </div>
                  )}
                  {newData.error && (
                    <div className="col-span-2">
                      <span className="text-slate-500">Error:</span>
                      <span className="ml-2 text-red-600">{newData.error}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Show attendance details specially */}
            {selectedLog.entity_type === "attendance" && (
              <div className="p-3 bg-purple-50 rounded-lg border border-purple-200">
                <p className="text-xs text-purple-700 font-semibold mb-2">📋 Attendance Details</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {oldData && oldData.status && (
                    <div>
                      <span className="text-slate-500">Previous Status:</span>
                      <span className="ml-2 font-medium">
                        {statusLabels[oldData.status] || oldData.status}
                      </span>
                    </div>
                  )}
                  {newData && newData.status && (
                    <div>
                      <span className="text-slate-500">New Status:</span>
                      <span className={`ml-2 font-medium ${
                        newData.status === 'P' ? 'text-emerald-600' :
                        newData.status === 'A' ? 'text-red-600' :
                        newData.status === 'L' ? 'text-yellow-600' :
                        newData.status === 'LV' ? 'text-blue-600' :
                        newData.status === 'SL' ? 'text-purple-600' :
                        'text-slate-600'
                      }`}>
                        {statusLabels[newData.status] || newData.status}
                      </span>
                    </div>
                  )}
                  {newData && newData.employee_name && (
                    <div className="col-span-2">
                      <span className="text-slate-500">Employee:</span>
                      <span className="ml-2 font-medium">{newData.employee_name}</span>
                    </div>
                  )}
                  {newData && newData.employee_number && (
                    <div>
                      <span className="text-slate-500">Employee #:</span>
                      <span className="ml-2">{newData.employee_number}</span>
                    </div>
                  )}
                  {newData && newData.date && (
                    <div>
                      <span className="text-slate-500">Date:</span>
                      <span className="ml-2">{new Date(newData.date).toLocaleDateString()}</span>
                    </div>
                  )}
                  {newData && newData.month && (
                    <div>
                      <span className="text-slate-500">Month:</span>
                      <span className="ml-2">{newData.month}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Show payment details specially */}
            {selectedLog.entity_type === "payment_status" && (
              <div className="p-3 bg-green-50 rounded-lg border border-green-200">
                <p className="text-xs text-green-700 font-semibold mb-2">💰 Payment Details</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {oldData && oldData.status && (
                    <div>
                      <span className="text-slate-500">Previous Status:</span>
                      <span className="ml-2 font-medium">
                        {paymentStatusLabels[oldData.status] || oldData.status}
                      </span>
                    </div>
                  )}
                  {newData && newData.status && (
                    <div>
                      <span className="text-slate-500">New Status:</span>
                      <span className={`ml-2 font-medium ${
                        newData.status === 'confirmed' ? 'text-emerald-600' :
                        newData.status === 'paid' ? 'text-indigo-600' :
                        newData.status === 'processing' ? 'text-blue-600' :
                        newData.status === 'pending' ? 'text-yellow-600' :
                        newData.status === 'failed' ? 'text-red-600' :
                        'text-slate-600'
                      }`}>
                        {paymentStatusLabels[newData.status] || newData.status}
                      </span>
                    </div>
                  )}
                  {newData && newData.employee_name && (
                    <div className="col-span-2">
                      <span className="text-slate-500">Employee:</span>
                      <span className="ml-2 font-medium">{newData.employee_name}</span>
                    </div>
                  )}
                  {newData && newData.employee_number && (
                    <div>
                      <span className="text-slate-500">Employee #:</span>
                      <span className="ml-2">{newData.employee_number}</span>
                    </div>
                  )}
                  {newData && newData.month && (
                    <div>
                      <span className="text-slate-500">Month:</span>
                      <span className="ml-2">{newData.month}</span>
                    </div>
                  )}
                  {newData && newData.payment_date && (
                    <div>
                      <span className="text-slate-500">Payment Date:</span>
                      <span className="ml-2">{new Date(newData.payment_date).toLocaleDateString()}</span>
                    </div>
                  )}
                  {newData && newData.account_number && (
                    <div>
                      <span className="text-slate-500">Account #:</span>
                      <span className="ml-2">{newData.account_number}</span>
                    </div>
                  )}
                  {newData && newData.transaction_id && (
                    <div className="col-span-2">
                      <span className="text-slate-500">Transaction ID:</span>
                      <span className="ml-2">{newData.transaction_id}</span>
                    </div>
                  )}
                  {newData && newData.notes && (
                    <div className="col-span-2">
                      <span className="text-slate-500">Notes:</span>
                      <span className="ml-2">{newData.notes}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Show raw data for other entity types or if there's extra data */}
            {selectedLog.entity_type !== "attendance" && 
             selectedLog.entity_type !== "payment_status" && 
             selectedLog.action !== "LOGIN" && (
              <>
                {oldData && Object.keys(oldData).length > 0 && (
                  renderFormattedData(selectedLog.entity_type, oldData, "Previous Data")
                )}
                {newData && Object.keys(newData).length > 0 && (
                  renderFormattedData(selectedLog.entity_type, newData, "New Data")
                )}
              </>
            )}

            {/* Show raw JSON if there's extra data not shown in the special views */}
            {selectedLog.entity_type === "attendance" && (
              <>
                {oldData && Object.keys(oldData).filter(k => !['status'].includes(k)).length > 0 && (
                  renderFormattedData(selectedLog.entity_type, oldData, "Previous Data (Additional)")
                )}
                {newData && Object.keys(newData).filter(k => !['status', 'employee_name', 'employee_number', 'date', 'month'].includes(k)).length > 0 && (
                  renderFormattedData(selectedLog.entity_type, newData, "New Data (Additional)")
                )}
              </>
            )}

            {selectedLog.entity_type === "payment_status" && (
              <>
                {oldData && Object.keys(oldData).filter(k => !['status'].includes(k)).length > 0 && (
                  renderFormattedData(selectedLog.entity_type, oldData, "Previous Data (Additional)")
                )}
                {newData && Object.keys(newData).filter(k => !['status', 'employee_name', 'employee_number', 'month', 'payment_date', 'account_number', 'transaction_id', 'notes'].includes(k)).length > 0 && (
                  renderFormattedData(selectedLog.entity_type, newData, "New Data (Additional)")
                )}
              </>
            )}

            {!oldData && !newData && (
              <div className="text-center py-4 text-slate-500 text-sm">
                No additional data available for this log entry
              </div>
            )}

            <div className="flex justify-end pt-4 border-t border-slate-100">
              <Button variant="outline" onClick={() => setSelectedLog(null)}>
                Close
              </Button>
            </div>
          </div>
          );
        })()}
      </Modal>
    </div>
  );
}

export default AuditLogsPage;