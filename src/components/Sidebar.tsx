import {
  LayoutDashboard, Users, DollarSign,
  FileText, Settings,
  Shield, History, LogOut, Menu, X,
  Wallet,
  Calculator, ClipboardList,
  CalendarCheck, BarChart3, BookOpen,
  Banknote
} from 'lucide-react';  // <-- Import directly from lucide-react
import { cn } from "../utils/cn";
import { supabase } from "../lib/supabase";
import { getCurrentProfile, UserProfile } from "../utils/currentProfile";
import { getCompanySettings } from "../utils/companySettings";
import {
  PERMISSIONS, PermissionKey, isBusinessAdmin, getMyPermissions,
  ROLE_DISPLAY_NAMES, FunctionalRole,
} from "../utils/permissions";
import { useState, useEffect, useCallback } from "react";
import { ChevronRight } from 'lucide-react';

export type NavKey =
  | "dashboard"
  | "employees"
  | "recruitment"
  | "attendance"
  | "payroll"
  | "payslips"
  | "payments"
  | "terminal-dues"
  | "salary-advances"
  | "reports"
  | "settings"
  | "security"
  | "features"
  | "auditlogs"
  | "user-manual";

// ===== ALL NAV ITEMS =====
const allNavItems: { id: NavKey; label: string; icon: any }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "employees", label: "Employees", icon: Users },
  { id: "terminal-dues", label: "Terminal Dues", icon: Calculator },
  { id: "salary-advances", label: "Salary Advances", icon: Banknote },
  { id: "recruitment", label: "Recruitment", icon: ClipboardList },
  { id: "attendance", label: "Attendance", icon: CalendarCheck },
  { id: "payroll", label: "Payroll", icon: Wallet },
  { id: "payslips", label: "Payslips", icon: FileText },
  { id: "payments", label: "Payments", icon: DollarSign },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "user-manual", label: "User Manual", icon: BookOpen },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "auditlogs", label: "Audit Logs", icon: History },
];

// Define which menu items each role can see
const roleMenuItems: Record<number, NavKey[]> = {
  1: [
    "dashboard",
    "employees",
    "recruitment",
    "attendance",
    "payroll",
    "payslips",
    "payments",
    "terminal-dues",
    "salary-advances",
    "reports",
    "settings",
    "security",
    "features",
    "auditlogs",
    "user-manual",
  ],
  2: [
    "dashboard",
    "employees",
    "recruitment",
    "attendance",
    "payments",
    "terminal-dues",
    "salary-advances",
    "reports",
    "security",
    "user-manual",
  ],
  3: ["dashboard", "attendance", "security", "user-manual"],
  4: ["dashboard", "payslips", "user-manual"],
};

// "security" and "features" are rendered separately (the "Special"
// section below, not the generic allNavItems loop), so they're not rows
// in allNavItems -- but a business admin (the ALL_NAV_KEYS branch in
// resolveAllowedPages() below) must still resolve as having them, so a
// FUNCTIONAL admin (role='admin', role_level=null -- not just a legacy
// role_level=1 account, which already gets both via roleMenuItems[1]
// above) sees the same Special-section items a legacy Admin always has.
// Appended explicitly here rather than added to allNavItems, so the
// generic visibleNavItems loop never renders them a second time.
const ALL_NAV_KEYS: NavKey[] = [...allNavItems.map((item) => item.id), "security", "features"];

// Governing permission(s) for each nav item, for a NEW functional-role
// account (role_level = NULL). A page is reachable if the account holds
// ANY ONE of the listed permissions -- e.g. "reports" is reachable with
// EITHER the financial OR the operational view permission (the deeper
// financial-vs-operational content split happens inside Reports.tsx
// itself). "settings" and "auditlogs" are deliberately absent -- both stay
// Admin-only (is_business_admin()), not permission-table-backed (see
// 20260817000004's PART 2 header and 20260817000001's PART 4
// respectively) -- a business admin reaches them via the ALL_NAV_KEYS
// branch in resolveAllowedPages() below, not through this map.
export const NAV_PERMISSIONS: Partial<Record<NavKey, PermissionKey[]>> = {
  dashboard: [PERMISSIONS.DASHBOARD_VIEW],
  employees: [PERMISSIONS.EMPLOYEES_VIEW],
  recruitment: [PERMISSIONS.RECRUITMENT_VIEW],
  attendance: [PERMISSIONS.ATTENDANCE_VIEW],
  payroll: [PERMISSIONS.PAYROLL_VIEW],
  payslips: [PERMISSIONS.PAYSLIPS_VIEW],
  payments: [PERMISSIONS.PAYMENTS_VIEW],
  "terminal-dues": [PERMISSIONS.TERMINAL_DUES_VIEW],
  "salary-advances": [PERMISSIONS.SALARY_ADVANCES_VIEW],
  reports: [PERMISSIONS.REPORTS_FINANCIAL_VIEW, PERMISSIONS.REPORTS_OPERATIONAL_VIEW],
  security: [PERMISSIONS.SECURITY_PERSONNEL_VIEW],
  features: [PERMISSIONS.FUTURE_FEATURES_VIEW],
  "user-manual": [PERMISSIONS.USER_MANUAL_VIEW],
};

// Shared derivation used by BOTH Sidebar (nav rendering) and App.tsx
// (routing guard) so the two can never drift apart. A LEGACY account
// (role_level IS NOT NULL) uses the EXACT SAME role_level -> page-list map
// it always has -- zero behavior change for any existing account. A
// functional-role account (role_level === null, by design -- see
// 20260817000000's header) is resolved from its permission set instead; a
// business admin (legacy role_level = 1 OR the new role = 'admin') always
// gets every page, matching Admin's existing full access.
export function resolveAllowedPages(
  profile: UserProfile | null,
  permissions: Set<string>,
  legacyMap: Record<number, NavKey[]>,
): NavKey[] {
  const roleLevel = profile?.role_level ?? null;
  if (roleLevel !== null) {
    return legacyMap[roleLevel] || legacyMap[4];
  }
  if (isBusinessAdmin(profile)) {
    return ALL_NAV_KEYS;
  }
  const pages = (Object.keys(NAV_PERMISSIONS) as NavKey[]).filter((key) =>
    NAV_PERMISSIONS[key]!.some((perm) => permissions.has(perm)),
  );
  return pages.length > 0 ? pages : (["dashboard", "user-manual"] as NavKey[]);
}

export function Sidebar({
  active,
  onNavigate,
  open,
  onClose,
  onPreload,
}: {
  active: NavKey;
  onNavigate: (k: NavKey) => void;
  open: boolean;
  onClose: () => void;
  onPreload?: (key: NavKey) => void;
}) {
  const [userRoleLevel, setUserRoleLevel] = useState<number | null>(4);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [allowedMenuIds, setAllowedMenuIds] = useState<NavKey[]>(roleMenuItems[4]);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState<string>("User");
  const [isMobile, setIsMobile] = useState(false);
  const [logoUrl, setLogoUrl] = useState('');

  // Real company logo (Settings -> Company), replacing the placeholder
  // Shield icon below when one has been uploaded.
  useEffect(() => {
    getCompanySettings().then(info => setLogoUrl(info.logoUrl));
  }, []);

  // ===== PERFORMANCE: Use matchMedia instead of window.innerWidth =====
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    const mql = window.matchMedia('(max-width: 1024px)');
    
    const handleChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (e.matches && open) {
        onClose();
      }
    };
    
    setIsMobile(mql.matches);
    mql.addEventListener('change', handleChange);
    
    return () => {
      mql.removeEventListener('change', handleChange);
    };
  }, [open, onClose]);

  // Prevent body scroll when sidebar is open on mobile
  useEffect(() => {
    if (open && isMobile) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [open, isMobile]);

  // Close sidebar on escape key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  useEffect(() => {
    const getUserInfo = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          let profile: any = null;
          let error: any = null;
          try {
            profile = await getCurrentProfile();
          } catch (e) {
            error = e;
          }

          if (error) {
            console.error("Error fetching profile:", error);
            setUserName(user.email?.split("@")[0] || "User");
            setUserRoleLevel(4);
            setAllowedMenuIds(roleMenuItems[4]);
          } else {
            setUserName(
              profile?.full_name || user.email?.split("@")[0] || "User",
            );
            const roleLevel = profile?.role_level ?? null;
            setUserRoleLevel(roleLevel);
            setUserRole(profile?.role ?? null);
            const businessAdmin = isBusinessAdmin(profile as UserProfile | null);

            let permissions = new Set<string>();
            if (roleLevel === null && !businessAdmin) {
              permissions = await getMyPermissions();
            }
            setAllowedMenuIds(
              resolveAllowedPages(profile as UserProfile | null, permissions, roleMenuItems),
            );
          }
        }
      } catch (err) {
        console.error("Failed to get user info:", err);
      } finally {
        setLoading(false);
      }
    };
    getUserInfo();
  }, []);

  const visibleNavItems = allNavItems.filter((item) =>
    allowedMenuIds.includes(item.id),
  );

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  const getRoleDisplay = () => {
    if (userRoleLevel === 1) return "Administrator";
    if (userRoleLevel === 2) return "Manager";
    if (userRoleLevel === 3) return "Supervisor";
    if (userRoleLevel === 4) return "Staff";
    // Functional-role account (role_level === null) -- display its real
    // role name instead of falling through to "Staff", which would
    // misrepresent a new hr_manager/accountant/operations_manager/admin
    // account as the legacy lowest-privilege role.
    if (userRole && userRole in ROLE_DISPLAY_NAMES) {
      return ROLE_DISPLAY_NAMES[userRole as FunctionalRole];
    }
    return "User";
  };

  // ===== PERFORMANCE: Memoize NavLink component =====
  const NavLink = useCallback(({ item }: { item: (typeof allNavItems)[number] }) => {
    const Icon = item.icon;
    const isActive = active === item.id;
    return (
      <button
        onClick={() => {
          onNavigate(item.id);
          if (isMobile) {
            onClose();
          }
        }}
        onMouseEnter={() => {
          if (onPreload) {
            onPreload(item.id);
          }
        }}
        onTouchStart={() => {
          if (onPreload) {
            onPreload(item.id);
          }
        }}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all group",
          isActive
            ? "bg-[#081C3A] text-white shadow-sm"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
        )}
      >
        <span className="icon-container" data-icon="true">
          <Icon size={18} className={isActive ? "text-[#D4A017]" : ""} />
        </span>
        <span className="flex-1 text-left">{item.label}</span>
        {isActive && <ChevronRight size={14} />}
      </button>
    );
  }, [active, onNavigate, isMobile, onClose, onPreload]);

  // Sidebar content
  const content = (
    <>
      <div className="p-5 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#081C3A] flex items-center justify-center shadow-md overflow-hidden">
            {logoUrl ? (
              <img src={logoUrl} alt="Company logo" className="w-full h-full object-contain" />
            ) : (
              <Shield size={20} className="text-[#D4A017]" />
            )}
          </div>
          <div>
            <p className="font-bold text-slate-800 text-sm leading-tight">
              Safeguard
            </p>
            <p className="text-xs text-slate-500">HR & Payroll</p>
          </div>
        </div>
        {isMobile && (
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100 transition-colors text-slate-500 hover:text-slate-700"
            aria-label="Close menu"
          >
            <X size={24} />
          </button>
        )}
      </div>

      <div className="p-3 flex-1 overflow-y-auto space-y-1">
        <p className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Main
        </p>
        {!loading &&
          visibleNavItems.map((item) => <NavLink key={item.id} item={item} />)}
        {loading && (
          <div className="px-3 py-2 text-sm text-slate-500">Loading...</div>
        )}

        {/* Permission-aware, not role-name-gated -- each item renders iff
            allowedMenuIds (the same resolveAllowedPages() result the route
            guard in App.tsx uses) actually contains it, so this section can
            never show a button the route guard would then deny, and never
            hide one the route guard already permits (see this file's own
            ALL_NAV_KEYS comment for how a business admin -- legacy or
            functional -- ends up with both). Previously gated on
            `userRoleLevel === 1 || userIsBusinessAdmin` alone, which ignored
            allowedMenuIds entirely and hid both items from every functional
            non-admin role (hr_manager/accountant/operations_manager) even
            though role_permissions already granted them
            future_features.view/security_personnel.view. */}
        {!loading && (allowedMenuIds.includes("security") || allowedMenuIds.includes("features")) && (
          <>
            <p className="px-3 py-2 mt-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Special
            </p>
            {allowedMenuIds.includes("security") && (
              <button
                onClick={() => {
                  onNavigate("security");
                  if (isMobile) {
                    onClose();
                  }
                }}
                onMouseEnter={() => {
                  if (onPreload) {
                    onPreload("security");
                  }
                }}
                onTouchStart={() => {
                  if (onPreload) {
                    onPreload("security");
                  }
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                  active === "security"
                    ? "bg-[#081C3A] text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100",
                )}
              >
                <Shield
                  size={18}
                  className={active === "security" ? "text-[#D4A017]" : ""}
                />
                <span>Security Personnel</span>
              </button>
            )}
            {allowedMenuIds.includes("features") && (
              <button
                onClick={() => {
                  onNavigate("features");
                  if (isMobile) {
                    onClose();
                  }
                }}
                onMouseEnter={() => {
                  if (onPreload) {
                    onPreload("features");
                  }
                }}
                onTouchStart={() => {
                  if (onPreload) {
                    onPreload("features");
                  }
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                  active === "features"
                    ? "bg-[#081C3A] text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100",
                )}
              >
                <span className="w-[18px] h-[18px] rounded bg-[#D4A017] text-white text-[10px] flex items-center justify-center font-bold">
                  ★
                </span>
                <span>Future Features</span>
              </button>
            )}
          </>
        )}
      </div>

      <div className="p-3 border-t border-slate-200">
        <div className="flex items-center gap-3 p-2 rounded-lg bg-slate-50 mb-2">
          <div className="w-9 h-9 rounded-full bg-[#D4A017] flex items-center justify-center text-white font-bold text-sm">
            {userName.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">
              {userName}
            </p>
            <p className="text-xs text-slate-500 truncate">
              {getRoleDisplay()}
            </p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-600 transition-colors"
        >
          <LogOut size={18} />
          <span>Logout</span>
        </button>
      </div>
    </>
  );

  return (
    <>
      <aside className="hidden lg:flex flex-col w-64 bg-white border-r border-slate-200 h-screen sticky top-0">
        {content}
      </aside>

      <div
        className={`lg:hidden fixed inset-0 z-50 transition-opacity duration-300 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div
          className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
          onClick={onClose}
        />
        <aside
          className={`absolute left-0 top-0 bottom-0 w-72 bg-white flex flex-col shadow-2xl transition-transform duration-300 ease-in-out ${
            open ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {content}
        </aside>
      </div>
    </>
  );
}

// ===== BOTTOM NAV =====
export function BottomNav({
  active,
  onNavigate,
}: {
  active: NavKey;
  onNavigate: (k: NavKey) => void;
}) {
  const [allowedBottomMenus, setAllowedBottomMenus] = useState<NavKey[]>(["dashboard", "employees", "payments", "payslips", "reports", "user-manual"]);
  const [loading, setLoading] = useState(true);

  const roleBottomItems: Record<number, NavKey[]> = {
    1: ["dashboard", "employees", "payroll", "payments", "terminal-dues", "attendance", "settings", "auditlogs", "user-manual"],
    2: ["dashboard", "employees", "terminal-dues", "attendance", "reports", "user-manual"],
    3: ["dashboard", "employees", "attendance","terminal-dues", "reports", "user-manual"],
    4: ["dashboard", "employees", "payments", "payslips", "reports", "user-manual"],
  };

  useEffect(() => {
    const getUserRole = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const profile = await getCurrentProfile();
          const roleLevel = profile?.role_level ?? null;
          const businessAdmin = isBusinessAdmin(profile as UserProfile | null);
          let permissions = new Set<string>();
          if (roleLevel === null && !businessAdmin) {
            permissions = await getMyPermissions();
          }
          // resolveAllowedPages() returns the FULL page set for the
          // caller; `allItems` below (a hand-curated subset for the
          // limited mobile bottom bar) is what actually narrows it --
          // same intersection pattern this bar already used for legacy
          // accounts via `roleBottomItems`.
          setAllowedBottomMenus(
            resolveAllowedPages(profile as UserProfile | null, permissions, roleBottomItems),
          );
        }
      } catch (err) {
        console.error("Failed to get role:", err);
      } finally {
        setLoading(false);
      }
    };
    getUserRole();
  }, []);

  const allItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "employees", label: "Employees", icon: Users },
    { id: "payroll", label: "Payroll", icon: Wallet },
    { id: "payments", label: "Payments", icon: DollarSign },
    { id: "terminal-dues", label: "Terminal Dues", icon: Calculator },
    { id: "attendance", label: "Attendance", icon: CalendarCheck },
    { id: "settings", label: "Settings", icon: Settings },
    { id: "reports", label: "Reports", icon: BarChart3 },
    { id: "security", label: "Security", icon: Shield },
    { id: "payslips", label: "Payslips", icon: FileText },
    { id: "auditlogs", label: "Audit Logs", icon: History },
    { id: "user-manual", label: "User Manual", icon: BookOpen },
  ];

  const items = allItems.filter((item) =>
    allowedBottomMenus.includes(item.id as NavKey),
  );

  if (loading) return null;

  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex justify-around p-1 z-40 pb-safe">
      {items.slice(0, 5).map((item) => {
        const Icon = item.icon;
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id as NavKey)}
            className={cn(
              "flex flex-col items-center gap-0.5 p-2 rounded-lg text-[10px] font-medium transition-colors min-w-[44px] min-h-[44px]",
              isActive ? "text-[#081C3A]" : "text-slate-500",
            )}
          >
            <Icon size={18} />
            <span className="whitespace-nowrap">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ===== TOP BAR =====
export function TopBar({
  onMenuClick,
  title,
  breadcrumb,
}: {
  onMenuClick: () => void;
  title: string;
  breadcrumb?: string;
}) {
  return (
    <div className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-slate-200">
      <div className="flex items-center justify-between px-4 md:px-6 py-3">
        <div className="flex items-center gap-3">
          <button
            className="lg:hidden w-10 h-10 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-600 transition-colors"
            onClick={onMenuClick}
            aria-label="Toggle menu"
          >
            <Menu size={24} />
          </button>
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="hidden sm:inline">Safeguard</span>
              {breadcrumb && (
                <>
                  <span>/</span>
                  <span>{breadcrumb}</span>
                </>
              )}
            </div>
            <h1 className="text-base md:text-lg font-semibold text-slate-800">
              {title}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-lg bg-[#E6F7F0] text-[#10B981] text-xs font-medium">
            <span className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
            System Online
          </div>
          <div className="w-10 h-10 rounded-full bg-[#D4A017] flex items-center justify-center text-white font-bold text-sm">
            SFG
          </div>
        </div>
      </div>
    </div>
  );
}