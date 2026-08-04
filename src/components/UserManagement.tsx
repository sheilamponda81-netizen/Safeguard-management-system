import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Button, Input, Modal, Badge } from './ui';
import { Plus, Trash2, Edit2 } from 'lucide-react';

interface Profile {
  id: string;
  email: string;
  role_level: number;
  full_name: string;
  department: string;
  is_super_admin: boolean;
  is_active: boolean;
  region_id: string | null;
  created_at: string;
}

type BadgeColor = 'navy' | 'gold' | 'green' | 'red' | 'blue' | 'gray' | 'yellow' | 'orange' | 'purple' | 'teal' | 'emerald' | 'cyan';

const roleLevels: { level: number; name: string; color: BadgeColor; desc: string }[] = [
  { level: 1, name: 'Admin', color: 'purple', desc: 'Full system access' },
  { level: 2, name: 'Manager', color: 'blue', desc: 'HR, Recruitment, Reports' },
  { level: 3, name: 'Supervisor', color: 'green', desc: 'Attendance, Security' },
  { level: 4, name: 'Staff', color: 'gray', desc: 'Basic access' }
];

export function UserManagement() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<Profile | null>(null);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    role_level: 4,
    full_name: '',
    department: ''
  });

  useEffect(() => {
    fetchUsers();
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

  const addUser = async () => {
    if (!formData.email || !formData.password) {
      alert('Email and password are required');
      return;
    }

    try {
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: {
          data: {
            role_level: formData.role_level,
            full_name: formData.full_name
          }
        }
      });

      if (authError) throw authError;

      if (authData.user) {
        const { error: profileError } = await supabase
          .from('profiles')
          .insert({
            id: authData.user.id,
            email: formData.email,
            role_level: formData.role_level,
            full_name: formData.full_name,
            department: formData.department,
            is_super_admin: formData.role_level === 1,
            is_active: true,
            region_id: null
          });

        if (profileError) throw profileError;

        alert(`User ${formData.email} created successfully`);
        setShowAddModal(false);
        setFormData({ email: '', password: '', role_level: 4, full_name: '', department: '' });
        fetchUsers();
      }
    } catch (error: any) {
      alert('Error creating user: ' + error.message);
    }
  };

  const updateUserRole = async (userId: string, roleLevel: number) => {
    const { error } = await supabase
      .from('profiles')
      .update({ 
        role_level: roleLevel,
        is_super_admin: roleLevel === 1
      })
      .eq('id', userId);

    if (error) {
      alert('Error updating user role');
    } else {
      alert('User role updated successfully');
      fetchUsers();
    }
  };

  // ===== FIXED: Delete User Function =====
  const deleteUser = async (user: Profile) => {
    if (!confirm(`Are you sure you want to permanently delete ${user.email}? This action cannot be undone.`)) {
      return;
    }

    try {
      // Check if this is the last admin user
      if (user.is_super_admin || user.role_level === 1) {
        const { count, error: countError } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('is_super_admin', true);

        if (countError) throw countError;
        
        if (count === 1) {
          alert('Cannot delete the last admin user. Please assign another admin first.');
          return;
        }
      }

      // Step 1: Delete from profiles
      const { error: profileError } = await supabase
        .from('profiles')
        .delete()
        .eq('id', user.id);

      if (profileError) {
        console.error('Profile deletion error:', profileError);
        
        // If foreign key error, try soft delete
        if (profileError.message?.includes('foreign key')) {
          const { error: updateError } = await supabase
            .from('profiles')
            .update({ 
              is_active: false,
              deleted_at: new Date().toISOString()
            })
            .eq('id', user.id);
            
          if (updateError) throw updateError;
          alert(`User ${user.email} has been deactivated (soft delete)`);
          fetchUsers();
          return;
        }
        throw profileError;
      }

      // Step 2: Try to delete from auth.users (may fail if no admin rights)
      try {
        const { error: authError } = await supabase.auth.admin.deleteUser(user.id);
        
        if (authError) {
          console.warn('Auth deletion warning:', authError);
          alert(`User ${user.email} was removed from profiles. Auth cleanup: ${authError.message}`);
        } else {
          alert(`User ${user.email} deleted successfully`);
        }
      } catch (authErr) {
        console.warn('Auth deletion error:', authErr);
        alert(`User ${user.email} was removed from profiles. Please manually remove from auth if needed.`);
      }

      fetchUsers();
    } catch (error: any) {
      console.error('Error deleting user:', error);
      alert('Error deleting user: ' + (error.message || 'Unknown error'));
    }
  };

  const getRoleColor = (level: number) => {
    const role = roleLevels.find(r => r.level === level);
    return role?.color || 'gray';
  };

  const getRoleName = (level: number) => {
    const role = roleLevels.find(r => r.level === level);
    return role?.name || 'Unknown';
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
        {roleLevels.map(role => (
          <div key={role.level} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <Badge color={role.color as any}>{role.name}</Badge>
            <p className="text-xs text-slate-500 mt-2">{role.desc}</p>
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
                users.map(user => (
                  <tr key={user.id} className={!user.is_active ? 'opacity-50' : ''}>
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-slate-800">{user.full_name || user.email?.split('@')[0]}</p>
                        <p className="text-xs text-slate-500">{user.email}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">{user.department || '-'}</td>
                    <td className="px-4 py-3">
                      <Badge color={getRoleColor(user.role_level)}>
                        {getRoleName(user.role_level)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <Badge color={user.is_active !== false ? 'green' : 'red'}>
                        {user.is_active !== false ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button 
                          onClick={() => { setSelectedUser(user); setShowEditModal(true); }} 
                          className="p-1.5 rounded-lg hover:bg-slate-100 text-amber-600"
                          title="Edit Role"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button 
                          onClick={() => deleteUser(user)} 
                          className="p-1.5 rounded-lg hover:bg-red-50 text-red-500"
                          title="Delete User"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add User Modal */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add New User" size="lg">
        <div className="space-y-4">
          <Input label="Email" type="email" value={formData.email} onChange={(e: any) => setFormData({...formData, email: e.target.value})} required />
          <Input label="Password" type="password" value={formData.password} onChange={(e: any) => setFormData({...formData, password: e.target.value})} required />
          <Input label="Full Name" value={formData.full_name} onChange={(e: any) => setFormData({...formData, full_name: e.target.value})} />
          <Input label="Department" value={formData.department} onChange={(e: any) => setFormData({...formData, department: e.target.value})} />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Access Level</label>
            <select 
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
              value={formData.role_level} 
              onChange={(e: any) => setFormData({...formData, role_level: parseInt(e.target.value)})}
            >
              {roleLevels.map(r => (
                <option key={r.level} value={r.level}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => setShowAddModal(false)}>Cancel</Button>
          <Button variant="secondary" onClick={addUser}>Create User</Button>
        </div>
      </Modal>

      {/* Edit User Modal */}
      <Modal open={showEditModal} onClose={() => setShowEditModal(false)} title="Edit User Access Level" size="md">
        {selectedUser && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">User: <strong>{selectedUser.email}</strong></p>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Access Level</label>
              <select 
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
                value={selectedUser.role_level} 
                onChange={(e: any) => setSelectedUser({...selectedUser, role_level: parseInt(e.target.value)})}
              >
                {roleLevels.map(r => (
                  <option key={r.level} value={r.level}>{r.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => setShowEditModal(false)}>Cancel</Button>
          <Button variant="secondary" onClick={() => {
            if (selectedUser) {
              updateUserRole(selectedUser.id, selectedUser.role_level);
              setShowEditModal(false);
            }
          }}>Save Changes</Button>
        </div>
      </Modal>
    </div>
  );
}