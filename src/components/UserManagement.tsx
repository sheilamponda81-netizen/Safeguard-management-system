import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Button, Input, Modal, Badge } from './ui';
import { Plus, UserX, Edit2 } from 'lucide-react';
import { getErrorMessage } from '../utils/errorHandler';
import { FUNCTIONAL_ROLES, FunctionalRole, ROLE_DISPLAY_NAMES } from '../utils/permissions';

interface Profile {
  id: string;
  email: string;
  role: string | null;
  role_level: number | null;
  full_name: string;
  department: string;
  is_super_admin: boolean;
  is_active: boolean;
  region_id: string | null;
  created_at: string;
}

interface Region {
  id: string;
  name: string;
}

type BadgeColor = 'navy' | 'gold' | 'green' | 'red' | 'blue' | 'gray' | 'yellow' | 'orange' | 'purple' | 'teal' | 'emerald' | 'cyan';

// Legacy numeric role_level accounts -- UNCHANGED, still supported for
// every existing account created before this rollout. Editing an
// EXISTING legacy account's role_level is still done directly (see
// updateLegacyUserRole below). Functional-role accounts (role_level IS
// NULL) get their own separate edit path -- updateFunctionalUser, via the
// update-user Edge Function -- rather than sharing this one, since the
// two account models have entirely different editable fields (a legacy
// numeric access level vs. full_name/department/role/region_id).
const legacyRoleLevels: { level: number; name: string; color: BadgeColor; desc: string }[] = [
  { level: 1, name: 'Admin', color: 'purple', desc: 'Full system access' },
  { level: 2, name: 'Manager', color: 'blue', desc: 'HR, Recruitment, Reports' },
  { level: 3, name: 'Supervisor', color: 'green', desc: 'Attendance, Security' },
  { level: 4, name: 'Staff', color: 'gray', desc: 'Basic access' }
];

// New functional roles -- see supabase/migrations/20260817000000's header
// for the full permission matrix behind each of these.
const functionalRoleInfo: Record<FunctionalRole, { color: BadgeColor; desc: string }> = {
  admin: { color: 'purple', desc: 'Full system access (same tenant)' },
  hr_manager: { color: 'blue', desc: 'Employees, Recruitment, Salary Advances, Terminal Dues' },
  accountant: { color: 'teal', desc: 'Payroll, Payments, Payslips, Salary Advances, Reports' },
  operations_manager: { color: 'orange', desc: 'Employees (view), Security, Attendance (view), Reports (operational)' },
};

export function UserManagement() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showFunctionalEditModal, setShowFunctionalEditModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<Profile | null>(null);
  const [functionalEditSubmitting, setFunctionalEditSubmitting] = useState(false);
  const [functionalEditForm, setFunctionalEditForm] = useState({
    full_name: '',
    department: '',
    role: 'hr_manager' as FunctionalRole,
    region_id: '',
  });
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    full_name: '',
    department: '',
    role: 'hr_manager' as FunctionalRole,
    region_id: '',
  });

  useEffect(() => {
    fetchUsers();
    fetchRegions();
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching users:', error);
      } else {
        setUsers(profiles || []);
      }
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchRegions = async () => {
    const { data, error } = await supabase.from('regions').select('id, name').order('name');
    if (!error) {
      setRegions(data || []);
    }
  };

  // ===== ADD USER =====
  // Delegates entirely to the create-user Edge Function -- see
  // supabase/functions/create-user/index.ts. This function runs with the
  // SERVICE ROLE key server-side and independently re-verifies the caller
  // is an Admin before doing anything; it NEVER accepts a client-supplied
  // tenant_id/role_level/is_super_admin. role_level is always NULL for
  // the new account (server-enforced, not something this form can
  // override).
  const addUser = async () => {
    if (!formData.email || !formData.password || !formData.full_name) {
      showFormAlert('Email, password, and full name are required');
      return;
    }
    if (formData.role !== 'admin' && !formData.region_id) {
      showFormAlert('Region is required for this role');
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-user', {
        body: {
          email: formData.email,
          password: formData.password,
          full_name: formData.full_name,
          department: formData.department || undefined,
          role: formData.role,
          region_id: formData.role === 'admin' ? null : formData.region_id,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      alert(`User ${formData.email} created successfully`);
      setShowAddModal(false);
      setFormData({ email: '', password: '', full_name: '', department: '', role: 'hr_manager', region_id: '' });
      fetchUsers();
    } catch (error) {
      alert('Error creating user: ' + getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const showFormAlert = (message: string) => alert(message);

  // ===== EDIT (LEGACY ONLY) =====
  // Only ever offered for an EXISTING legacy account (role_level IS NOT
  // NULL). Deliberately touches role_level ONLY -- is_super_admin is a
  // separate, more powerful concept (cross-tenant, platform-level) that
  // must never be a side effect of picking an access level here. A
  // previous version of this function sent `is_super_admin: roleLevel ===
  // 1`, silently asking to grant real super-admin status any time this
  // control was used to set someone's level to "Admin" -- prevent_profile_
  // privilege_escalation()'s trigger already discarded that request for
  // any caller who wasn't ALREADY a super-admin, so it was never
  // exploitable by an ordinary Admin, but it WAS a real over-grant risk
  // for the one caller class who could trigger it (a genuine super-admin
  // using this control, without any label warning them it also grants
  // cross-tenant super-admin status). Removed entirely -- if genuine
  // super-admin promotion is ever needed, it must be its own explicit,
  // clearly-labeled action, never a side effect of this dropdown.
  const updateLegacyUserRole = async (userId: string, roleLevel: number) => {
    const { error } = await supabase
      .from('profiles')
      .update({ role_level: roleLevel })
      .eq('id', userId);

    if (error) {
      alert('Error updating user role');
    } else {
      alert('User role updated successfully');
      fetchUsers();
    }
  };

  // ===== EDIT (FUNCTIONAL ROLES) =====
  // Delegates entirely to the update-user Edge Function -- see
  // supabase/functions/update-user/index.ts -- which in turn invokes the
  // update_functional_user_profile() SECURITY DEFINER RPC using a client
  // scoped to the CALLER's own JWT (not the service-role key), so the
  // database's own auth.uid()-based checks and the last-Admin invariant
  // resolve and enforce correctly. Only full_name/department/role/
  // region_id are ever sent -- no email/password/tenant_id/role_level/
  // is_super_admin field exists on this form at all.
  const updateFunctionalUser = async () => {
    if (!selectedUser) return;
    if (!functionalEditForm.full_name.trim()) {
      alert('Full name is required');
      return;
    }
    if (functionalEditForm.role !== 'admin' && !functionalEditForm.region_id) {
      alert('Region is required for this role');
      return;
    }

    setFunctionalEditSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('update-user', {
        body: {
          user_id: selectedUser.id,
          full_name: functionalEditForm.full_name,
          department: functionalEditForm.department || undefined,
          role: functionalEditForm.role,
          region_id: functionalEditForm.role === 'admin' ? null : functionalEditForm.region_id,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      alert(`${functionalEditForm.full_name} updated successfully`);
      setShowFunctionalEditModal(false);
      fetchUsers();
    } catch (error) {
      alert('Error updating user: ' + getErrorMessage(error));
    } finally {
      setFunctionalEditSubmitting(false);
    }
  };

  // ===== DISABLE USER =====
  // Delegates to the disable-user Edge Function -- see
  // supabase/functions/disable-user/index.ts. This is a SOFT DISABLE
  // (profiles.is_active = false) only -- a genuine hard delete is
  // deliberately not implemented (see that function's own header for the
  // full reasoning: profiles.id is referenced by historical/audit data
  // throughout this schema, and disabling is already a complete access
  // revocation). Replaces the prior client-side flow, which attempted a
  // direct `profiles` DELETE (breaks on FK references) followed by
  // `supabase.auth.admin.deleteUser()` (an admin-only API unreachable from
  // a browser using the anon key -- that call could only ever fail).
  const disableUser = async (user: Profile) => {
    if (!confirm(`Disable ${user.email}? They will immediately lose all access. This can be reversed later by an Admin.`)) {
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke('disable-user', {
        body: { user_id: user.id },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      alert(`User ${user.email} has been disabled`);
      fetchUsers();
    } catch (error) {
      alert('Error disabling user: ' + getErrorMessage(error));
    }
  };

  // Re-enabling is a plain, non-privileged field update -- profiles'
  // UPDATE RLS policy already allows an Admin to flip another user's
  // is_active back on directly (unlike role/region_id/role_level/
  // is_super_admin, is_active is not locked by
  // prevent_profile_privilege_escalation()), so this does not need its own
  // Edge Function for correctness. KNOWN GAP, documented rather than
  // silently accepted: unlike disable (which writes a server-verified
  // audit_logs row inside disable-user/index.ts), this direct client write
  // has no authoritative audit trail -- a client-inserted audit row would
  // be forgeable and is not treated as equivalent here. Authoritative
  // enable auditing (e.g. a matching enable-user Edge Function) is a
  // deliberate follow-up item, out of scope for this change.
  const enableUser = async (user: Profile) => {
    const { error } = await supabase.from('profiles').update({ is_active: true }).eq('id', user.id);
    if (error) {
      alert('Error enabling user: ' + getErrorMessage(error));
    } else {
      alert(`User ${user.email} has been re-enabled`);
      fetchUsers();
    }
  };

  const isLegacyUser = (user: Profile) => user.role_level !== null && user.role_level !== undefined;

  const getRoleBadge = (user: Profile): { label: string; color: BadgeColor } => {
    if (isLegacyUser(user)) {
      const role = legacyRoleLevels.find(r => r.level === user.role_level);
      return { label: role?.name || 'Unknown', color: role?.color || 'gray' };
    }
    const role = user.role as FunctionalRole;
    if (role && role in functionalRoleInfo) {
      return { label: ROLE_DISPLAY_NAMES[role], color: functionalRoleInfo[role].color };
    }
    return { label: 'Unknown', color: 'gray' };
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-semibold text-slate-800">System Users</h3>
          <p className="text-xs text-slate-500">Create and manage user accounts with role-based access</p>
        </div>
        <Button variant="secondary" onClick={() => setShowAddModal(true)}>
          <Plus size={14} className="mr-1" /> Add User
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {FUNCTIONAL_ROLES.map(role => (
          <div key={role} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <Badge color={functionalRoleInfo[role].color}>{ROLE_DISPLAY_NAMES[role]}</Badge>
            <p className="text-xs text-slate-500 mt-2">{functionalRoleInfo[role].desc}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F8FAFC] border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left">User</th>
                <th className="px-4 py-3 text-left hidden md:table-cell">Department</th>
                <th className="px-4 py-3 text-left">Access Level</th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={5} className="text-center py-8">Loading users...</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-8">No users found. Add your first user!</td></tr>
              ) : (
                users.map(user => {
                  const badge = getRoleBadge(user);
                  const legacy = isLegacyUser(user);
                  return (
                    <tr key={user.id} className={!user.is_active ? 'opacity-50' : ''}>
                      <td className="px-4 py-3">
                        <div>
                          <p className="font-medium text-slate-800">{user.full_name || user.email?.split('@')[0]}</p>
                          <p className="text-xs text-slate-500">{user.email}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">{user.department || '-'}</td>
                      <td className="px-4 py-3">
                        <Badge color={badge.color}>{badge.label}</Badge>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <Badge color={user.is_active !== false ? 'green' : 'red'}>
                          {user.is_active !== false ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {legacy ? (
                            <button
                              onClick={() => { setSelectedUser(user); setShowEditModal(true); }}
                              className="p-1.5 rounded-lg hover:bg-slate-100 text-amber-600"
                              title="Edit Role (legacy account)"
                            >
                              <Edit2 size={14} />
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setSelectedUser(user);
                                setFunctionalEditForm({
                                  full_name: user.full_name || '',
                                  department: user.department || '',
                                  role: (user.role as FunctionalRole) || 'hr_manager',
                                  region_id: user.region_id || '',
                                });
                                setShowFunctionalEditModal(true);
                              }}
                              className="p-1.5 rounded-lg hover:bg-slate-100 text-amber-600"
                              title="Edit User"
                            >
                              <Edit2 size={14} />
                            </button>
                          )}
                          {user.is_active !== false ? (
                            <button
                              onClick={() => disableUser(user)}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-red-500"
                              title="Deactivate User"
                            >
                              <UserX size={14} />
                            </button>
                          ) : (
                            <button
                              onClick={() => enableUser(user)}
                              className="px-2 py-1 rounded-lg hover:bg-green-50 text-green-600 text-xs font-medium"
                              title="Re-enable User"
                            >
                              Enable
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add User Modal */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add New User" size="lg">
        <div className="space-y-4">
          <Input label="Email" type="email" value={formData.email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({...formData, email: e.target.value})} required />
          <Input label="Password" type="password" value={formData.password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({...formData, password: e.target.value})} required />
          <Input label="Full Name" value={formData.full_name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({...formData, full_name: e.target.value})} required />
          <Input label="Department" value={formData.department} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({...formData, department: e.target.value})} />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Role</label>
            <select
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
              value={formData.role}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFormData({...formData, role: e.target.value as FunctionalRole})}
            >
              {FUNCTIONAL_ROLES.map(role => (
                <option key={role} value={role}>{ROLE_DISPLAY_NAMES[role]}</option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">{functionalRoleInfo[formData.role].desc}</p>
          </div>
          {formData.role !== 'admin' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Region</label>
              <select
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
                value={formData.region_id}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFormData({...formData, region_id: e.target.value})}
                required
              >
                <option value="">-- Please select a region --</option>
                {regions.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => setShowAddModal(false)} disabled={submitting}>Cancel</Button>
          <Button variant="secondary" onClick={addUser} disabled={submitting}>
            {submitting ? 'Creating...' : 'Create User'}
          </Button>
        </div>
      </Modal>

      {/* Edit User Modal (legacy accounts only) */}
      <Modal open={showEditModal} onClose={() => setShowEditModal(false)} title="Edit User Access Level" size="md">
        {selectedUser && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">User: <strong>{selectedUser.email}</strong></p>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Access Level</label>
              <select
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
                value={selectedUser.role_level ?? 4}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedUser({...selectedUser, role_level: parseInt(e.target.value)})}
              >
                {legacyRoleLevels.map(r => (
                  <option key={r.level} value={r.level}>{r.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => setShowEditModal(false)}>Cancel</Button>
          <Button variant="secondary" onClick={() => {
            if (selectedUser && selectedUser.role_level !== null) {
              updateLegacyUserRole(selectedUser.id, selectedUser.role_level);
              setShowEditModal(false);
            }
          }}>Save Changes</Button>
        </div>
      </Modal>

      {/* Edit User Modal (functional-role accounts only) */}
      <Modal open={showFunctionalEditModal} onClose={() => setShowFunctionalEditModal(false)} title="Edit User" size="lg">
        {selectedUser && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">User: <strong>{selectedUser.email}</strong></p>
            <Input
              label="Full Name"
              value={functionalEditForm.full_name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFunctionalEditForm({ ...functionalEditForm, full_name: e.target.value })}
              required
            />
            <Input
              label="Department"
              value={functionalEditForm.department}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFunctionalEditForm({ ...functionalEditForm, department: e.target.value })}
            />
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Role</label>
              <select
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
                value={functionalEditForm.role}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFunctionalEditForm({ ...functionalEditForm, role: e.target.value as FunctionalRole })}
              >
                {FUNCTIONAL_ROLES.map(role => (
                  <option key={role} value={role}>{ROLE_DISPLAY_NAMES[role]}</option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-1">{functionalRoleInfo[functionalEditForm.role].desc}</p>
            </div>
            {functionalEditForm.role !== 'admin' ? (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Region</label>
                <select
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
                  value={functionalEditForm.region_id}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFunctionalEditForm({ ...functionalEditForm, region_id: e.target.value })}
                  required
                >
                  <option value="">-- Please select a region --</option>
                  {regions.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-xs text-slate-500">Admin has access to all regions in this tenant.</p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => setShowFunctionalEditModal(false)} disabled={functionalEditSubmitting}>Cancel</Button>
          <Button variant="secondary" onClick={updateFunctionalUser} disabled={functionalEditSubmitting}>
            {functionalEditSubmitting ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
