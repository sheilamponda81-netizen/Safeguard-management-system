import { useState, useEffect } from "react";
import {
  Search,
  Download,
  Eye,
  Activity,
  User,
  Clock,
  Calendar,
  Filter,
  RefreshCw,
  History,
  Mail,
  Shield,
  AlertTriangle,
} from "lucide-react";
import {
  Card,
  Button,
  Badge,
  PageHeader,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Modal,
} from "../components/ui";
import { supabase } from "../lib/supabase";
import { showNotification } from "../utils/clickHandlers";

export function AuditLogsPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterAction, setFilterAction] = useState("all");
  const [filterEntity, setFilterEntity] = useState("all");
  const [filterUser, setFilterUser] = useState("all");
  const [userProfile, setUserProfile] = useState<any>(null);
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [uniqueUsers, setUniqueUsers] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({
    start: "",
    end: "",
  });
  const [stats, setStats] = useState({
    total: 0,
    today: 0,
    thisWeek: 0,
    thisMonth: 0,
    byAction: {} as Record<string, number>,
  });

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
    "employee",
    "attendance",
    "applicant",
    "user",
    "role",
    "payroll",
    "payslip",
    "payment",
    "terminal_dues",
    "settings",
  ];

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

  useEffect(() => {
    if (userProfile) {
      fetchAuditLogs();
    }
  }, [userProfile, filterAction, filterEntity, filterUser, dateRange]);

  const fetchAuditLogs = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000);

      if (filterAction !== "all") {
        query = query.eq("action", filterAction);
      }
      if (filterEntity !== "all") {
        query = query.eq("entity_type", filterEntity);
      }
      if (filterUser !== "all") {
        query = query.eq("user_email", filterUser);
      }
      if (dateRange.start) {
        query = query.gte("created_at", dateRange.start);
      }
      if (dateRange.end) {
        query = query.lte("created_at", dateRange.end);
      }

      if (!userProfile?.is_super_admin && userProfile?.region_id) {
        query = query.eq("region_id", userProfile.region_id);
      }

      const { data, error } = await query;
      if (error) throw error;
      
      const logsData = data || [];
      setLogs(logsData);

      // Calculate stats
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const monthAgo = new Date(today);
      monthAgo.setMonth(monthAgo.getMonth() - 1);

      const actionCounts: Record<string, number> = {};
      logsData.forEach((log: any) => {
        actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
      });

      setStats({
        total: logsData.length,
        today: logsData.filter((l: any) => new Date(l.created_at) >= today).length,
        thisWeek: logsData.filter((l: any) => new Date(l.created_at) >= weekAgo).length,
        thisMonth: logsData.filter((l: any) => new Date(l.created_at) >= monthAgo).length,
        byAction: actionCounts,
      });

      // Extract unique users
      const users = [...new Set(logsData.map((l: any) => l.user_email).filter(Boolean))];
      setUniqueUsers(users);
    } catch (err: any) {
      console.error("Error fetching audit logs:", err);
      showNotification("Failed to load audit logs", "error");
    } finally {
      setLoading(false);
    }
  };

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
        return "purple";
      case "APPROVE":
        return "teal";
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
        return "📤";
      case "VIEW":
        return "👁️";
      case "APPROVE":
        return "✅";
      case "REJECT":
        return "❌";
      default:
        return "📝";
    }
  };

  const formatChanges = (oldData: any, newData: any) => {
    if (!oldData && !newData) return "No changes tracked";
    
    const changes: string[] = [];
    
    if (oldData && newData) {
      const allKeys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
      allKeys.forEach(key => {
        const oldVal = oldData[key];
        const newVal = newData[key];
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          if (oldVal === undefined) {
            changes.push(`Added ${key}: ${JSON.stringify(newVal)}`);
          } else if (newVal === undefined) {
            changes.push(`Removed ${key}: ${JSON.stringify(oldVal)}`);
          } else {
            changes.push(`${key}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
          }
        }
      });
    }
    
    return changes.length > 0 ? changes.join("; ") : "No significant changes";
  };

  const filteredLogs = logs.filter(
    (log) =>
      log.user_email?.toLowerCase().includes(search.toLowerCase()) ||
      log.action?.toLowerCase().includes(search.toLowerCase()) ||
      log.entity_type?.toLowerCase().includes(search.toLowerCase()) ||
      log.entity_id?.toLowerCase().includes(search.toLowerCase()) ||
      (log.new_data && JSON.stringify(log.new_data).toLowerCase().includes(search.toLowerCase()))
  );

  const exportLogs = () => {
    if (filteredLogs.length === 0) {
      showNotification("No logs to export", "error");
      return;
    }

    const headers = [
      "Date",
      "User Email",
      "User Role",
      "Action",
      "Entity Type",
      "Entity ID",
      "IP Address",
      "User Agent",
      "Changes",
      "Old Data",
      "New Data",
    ];
    
    const rows = filteredLogs.map((log) => [
      new Date(log.created_at).toLocaleString(),
      log.user_email || "System",
      log.user_role || "Unknown",
      log.action,
      log.entity_type,
      log.entity_id || "-",
      log.ip_address || "-",
      log.user_agent || "-",
      formatChanges(log.old_data, log.new_data),
      log.old_data ? JSON.stringify(log.old_data) : "",
      log.new_data ? JSON.stringify(log.new_data) : "",
    ]);

    const csv = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

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
          <Shield size={32} className="text-red-500" />
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
        subtitle="Complete audit trail of all user actions and system changes"
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
              <Activity size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">Total Actions</p>
              <p className="text-xl font-bold text-slate-800">{stats.total}</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <Calendar size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">Today</p>
              <p className="text-xl font-bold text-slate-800">{stats.today}</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center">
              <Clock size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">This Week</p>
              <p className="text-xl font-bold text-slate-800">{stats.thisWeek}</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#FFF1CC] text-[#D4A017] flex items-center justify-center">
              <History size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">This Month</p>
              <p className="text-xl font-bold text-slate-800">{stats.thisMonth}</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-100 text-red-600 flex items-center justify-center">
              <AlertTriangle size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-500">Actions Today</p>
              <p className="text-xl font-bold text-red-600">{stats.today}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Action Breakdown */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(stats.byAction).map(([action, count]) => (
          <Badge key={action} color={getActionBadgeColor(action)} className="text-xs">
            {getActionIcon(action)} {action}: {count}
          </Badge>
        ))}
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <div className="relative md:col-span-2">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all fields..."
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
          <select
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]"
          >
            <option value="all">All Users</option>
            {uniqueUsers.map((user) => (
              <option key={user} value={user}>
                {user}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            onClick={() => {
              setDateRange({ start: "", end: "" });
              setFilterAction("all");
              setFilterEntity("all");
              setFilterUser("all");
              setSearch("");
            }}
            className="text-xs"
          >
            <Filter size={14} className="mr-1" /> Clear Filters
          </Button>
        </div>
      </Card>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F8FAFC] border-b border-slate-200 sticky top-0">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-slate-600 min-w-[120px]">Timestamp</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600 min-w-[150px]">User</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600 min-w-[100px]">Action</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600 min-w-[120px]">Entity</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600 min-w-[200px]">Changes</th>
                <th className="px-4 py-3 text-right font-semibold text-slate-600 min-w-[60px]">View</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredLogs.slice(0, 200).map((log) => {
                const changes = formatChanges(log.old_data, log.new_data);
                return (
                  <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-xs">
                        {new Date(log.created_at).toLocaleDateString()}
                        <br />
                        <span className="text-slate-400 text-[10px]">
                          {new Date(log.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-[#081C3A] text-white text-xs font-bold flex items-center justify-center">
                          {log.user_email?.charAt(0).toUpperCase() || "S"}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-slate-800">
                            {log.user_email?.split("@")[0] || "System"}
                          </div>
                          <div className="text-xs text-slate-400 capitalize flex items-center gap-1">
                            <Mail size={10} />
                            {log.user_email || "system@safeguard.mw"}
                          </div>
                          <div className="text-xs text-slate-400 capitalize">
                            Role: {log.user_role || "user"}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <span className="text-lg">{getActionIcon(log.action)}</span>
                        <Badge color={getActionBadgeColor(log.action)}>
                          {log.action}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <span className="text-xs font-mono text-slate-600 bg-slate-100 px-2 py-0.5 rounded inline-block w-fit">
                          {log.entity_type || "unknown"}
                        </span>
                        {log.entity_id && (
                          <span className="text-[10px] text-slate-400 mt-1 font-mono">
                            ID: {log.entity_id.substring(0, 8)}...
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-slate-600 max-w-[300px] truncate">
                        {changes}
                      </div>
                      {log.old_data && log.new_data && (
                        <div className="flex gap-1 mt-1">
                          <Badge color="gray" className="text-[8px]">Old</Badge>
                          <Badge color="green" className="text-[8px]">New</Badge>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-600 transition-colors"
                        title="View details"
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
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-500 flex justify-between items-center">
            <span>Showing {Math.min(200, filteredLogs.length)} of {filteredLogs.length} logs</span>
            <span>Last {filteredLogs.length} entries</span>
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
        {selectedLog && (
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
                <p className="text-xs text-slate-400">Role: {selectedLog.user_role || "user"}</p>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Action</p>
                <Badge color={getActionBadgeColor(selectedLog.action)}>
                  {getActionIcon(selectedLog.action)} {selectedLog.action}
                </Badge>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Entity</p>
                <p className="font-mono text-xs">
                  {selectedLog.entity_type || "unknown"} - {selectedLog.entity_id || "N/A"}
                </p>
              </div>
              {selectedLog.ip_address && (
                <div>
                  <p className="text-slate-500 text-xs">IP Address</p>
                  <p className="font-mono text-xs">{selectedLog.ip_address}</p>
                </div>
              )}
              {selectedLog.user_agent && (
                <div>
                  <p className="text-slate-500 text-xs">Device</p>
                  <p className="text-xs text-slate-600 truncate">{selectedLog.user_agent}</p>
                </div>
              )}
            </div>
            
            {/* Changes Comparison */}
            <div className="border-t pt-4">
              <p className="text-slate-500 text-xs mb-2">Changes</p>
              <div className="grid grid-cols-2 gap-4">
                {selectedLog.old_data && Object.keys(selectedLog.old_data).length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-red-600 mb-1">Previous Data</p>
                    <pre className="bg-red-50 p-3 rounded-lg text-xs overflow-auto max-h-40 border border-red-200">
                      {JSON.stringify(selectedLog.old_data, null, 2)}
                    </pre>
                  </div>
                )}
                {selectedLog.new_data && Object.keys(selectedLog.new_data).length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-green-600 mb-1">New Data</p>
                    <pre className="bg-green-50 p-3 rounded-lg text-xs overflow-auto max-h-40 border border-green-200">
                      {JSON.stringify(selectedLog.new_data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
              {!selectedLog.old_data && !selectedLog.new_data && (
                <div className="text-center py-4 text-slate-500 text-sm">
                  No additional data available for this log entry
                </div>
              )}
            </div>
            
            <div className="flex justify-end pt-4 border-t border-slate-100">
              <Button variant="outline" onClick={() => setSelectedLog(null)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default AuditLogsPage;