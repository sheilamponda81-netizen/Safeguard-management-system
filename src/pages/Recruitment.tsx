import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, UserCheck, XCircle, CheckCircle2, Eye, UserPlus, FileText } from '../utils/icons';

import { Card, Button, Badge, PageHeader, THead, TBody, TR, TH, TD, Modal } from '../components/ui';
import { showNotification } from '../utils/clickHandlers';
import { supabase } from '../lib/supabase';
import { getCurrentProfile } from '../utils/currentProfile';
import { logAudit } from '../utils/auditLogger';
import { Pagination } from '../components/Pagination';
import { getDefaultPageSize } from '../utils/uiSettings';

interface Applicant {
  id: string;
  name: string;
  position: string;
  qualification: string;
  phone: string;
  email: string;
  experience: string;
  interview_status: string;
  decision: string;
  application_date: string;
  cover_letter?: string;
  cv_url?: string;
  region_id?: string;
}

export function RecruitmentPage() {
  // ===== ALL HOOKS AT TOP LEVEL =====
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState<Applicant | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [regions, setRegions] = useState<any[]>([]);

  // ===== PAGINATION STATES =====
  const [recruitmentPage, setRecruitmentPage] = useState(1);
  const [recruitmentItemsPerPage, setRecruitmentItemsPerPage] = useState(20);
  useEffect(() => { getDefaultPageSize().then(setRecruitmentItemsPerPage); }, []);

  // ===== MEMOIZED VALUES =====
  const isSuperAdmin = useMemo(() => userProfile?.is_super_admin, [userProfile]);
  const userRegion = useMemo(() => userProfile?.regions, [userProfile]);

  const filtered = useMemo(() => {
    return applicants.filter(a =>
      (a.name.toLowerCase().includes(search.toLowerCase()) || a.position.toLowerCase().includes(search.toLowerCase())) &&
      (filter === 'all' || a.interview_status.toLowerCase().includes(filter.toLowerCase()))
    );
  }, [applicants, search, filter]);

  // ===== PAGINATED APPLICANTS =====
  const paginatedApplicants = useMemo(() => {
    const startIndex = (recruitmentPage - 1) * recruitmentItemsPerPage;
    const endIndex = Math.min(startIndex + recruitmentItemsPerPage, filtered.length);
    return filtered.slice(startIndex, endIndex);
  }, [filtered, recruitmentPage, recruitmentItemsPerPage]);

  // ===== RESET PAGE WHEN SEARCH OR FILTER CHANGES =====
  useEffect(() => {
    setRecruitmentPage(1);
  }, [search, filter]);

  const counts = useMemo(() => ({
    total: applicants.length,
    shortlisted: applicants.filter(a => a.interview_status === 'Shortlisted').length,
    interviewed: applicants.filter(a => a.interview_status === 'Interviewed').length,
    accepted: applicants.filter(a => a.interview_status === 'Accepted').length,
    rejected: applicants.filter(a => a.interview_status === 'Rejected').length
  }), [applicants]);

  // ===== CALLBACKS =====
  const fetchUserProfile = useCallback(async () => {
    const profile = await getCurrentProfile();
    setUserProfile(profile);
  }, []);

  // Only needed for a super admin to pick which region a new applicant
  // belongs to -- regional users are always scoped to their own region.
  const fetchRegions = useCallback(async () => {
    const { data } = await supabase.from('regions').select('*');
    setRegions(data || []);
  }, []);

  const fetchApplicants = useCallback(async () => {
    setLoading(true);
    let query = supabase.from('applicants').select('*').order('created_at', { ascending: false });

    if (!userProfile?.is_super_admin && userProfile?.region_id) {
      query = query.eq('region_id', userProfile.region_id);
    }

    const { data, error } = await query;
    
    if (error) {
      console.error('Error fetching applicants:', error);
      showNotification('Failed to load applicants', 'error');
    } else {
      setApplicants(data || []);
    }
    setLoading(false);
  }, [userProfile]);

  // ===== INITIALIZATION =====
  useEffect(() => {
    const init = async () => {
      await fetchUserProfile();
      await fetchRegions();
    };
    init();
  }, [fetchUserProfile, fetchRegions]);

  useEffect(() => {
    if (userProfile) {
      fetchApplicants();
    }
  }, [userProfile, fetchApplicants]);

  // ===== UPDATE APPLICANT =====
  const update = useCallback(async (id: string, status: string, decision: string = 'Pending') => {
    const applicant = applicants.find(a => a.id === id);
    if (!applicant) return;
    
    const oldStatus = applicant.interview_status;
    const oldDecision = applicant.decision;
    
    if (!userProfile?.is_super_admin && applicant?.region_id && applicant.region_id !== userProfile?.region_id) {
      showNotification('You can only edit applicants from your region', 'error');
      return;
    }
    
    const { error } = await supabase
      .from('applicants')
      .update({ interview_status: status, decision })
      .eq('id', id);
    
    if (error) {
      showNotification('Error updating status: ' + error.message, 'error');
    } else {
      setApplicants(applicants.map(a => a.id === id ? { ...a, interview_status: status, decision } : a));
      
      await logAudit({
        action: 'UPDATE',
        entity_type: 'applicant',
        entity_id: id,
        old_data: {
          name: applicant.name,
          position: applicant.position,
          interview_status: oldStatus,
          decision: oldDecision
        },
        new_data: {
          name: applicant.name,
          position: applicant.position,
          interview_status: status,
          decision: decision
        },
        region_id: userProfile?.region_id
      });
      
      showNotification(`Applicant status updated to ${status}`, 'success');
    }
  }, [applicants, userProfile]);

  // ===== ADD APPLICANT =====
  const addApplicant = useCallback(async (newApplicant: any) => {
    // A super admin has no region of their own, so they must explicitly pick
    // one for a new applicant (same requirement Employees.tsx's Add Employee
    // form already enforces) -- otherwise the applicant would be saved with
    // region_id: null and become invisible to every regional recruiter's
    // region-scoped view, effectively orphaned.
    let assignedRegionId = newApplicant.region_id || null;
    if (!userProfile?.is_super_admin) {
      assignedRegionId = userProfile?.region_id || null;
    } else if (!assignedRegionId) {
      showNotification('Please select a region', 'error');
      return;
    }

    const { data, error } = await supabase
      .from('applicants')
      .insert([{
        name: newApplicant.name,
        position: newApplicant.position,
        qualification: newApplicant.qualification,
        phone: newApplicant.phone,
        email: newApplicant.email,
        experience: newApplicant.experience,
        interview_status: 'Pending',
        decision: 'Pending',
        application_date: new Date().toISOString().split('T')[0],
        cover_letter: newApplicant.coverLetter || null,
        region_id: assignedRegionId,
      }])
      .select();

    if (error) {
      showNotification('Error adding applicant: ' + error.message, 'error');
    } else if (data && data[0]) {
      setApplicants([data[0], ...applicants]);

      await logAudit({
        action: 'CREATE',
        entity_type: 'applicant',
        entity_id: data[0].id,
        new_data: {
          name: newApplicant.name,
          position: newApplicant.position,
          qualification: newApplicant.qualification,
          phone: newApplicant.phone,
          email: newApplicant.email,
          experience: newApplicant.experience,
          interview_status: 'Pending',
          decision: 'Pending',
          region_id: assignedRegionId
        },
        region_id: assignedRegionId
      });

      showNotification(`${newApplicant.name} has been added to recruitment pipeline`, 'success');
      setShowAddModal(false);
    }
  }, [applicants, userProfile]);

  // ===== VIEW APPLICANT =====
  const handleViewApplicant = useCallback(async (applicant: Applicant) => {
    setView(applicant);
    
    await logAudit({
      action: 'VIEW',
      entity_type: 'applicant',
      entity_id: applicant.id,
      new_data: {
        name: applicant.name,
        position: applicant.position,
        interview_status: applicant.interview_status
      },
      region_id: userProfile?.region_id
    });
  }, [userProfile]);

  // ===== ADD APPLICANT MODAL =====
  const AddApplicantModal = useCallback(() => {
    const [formData, setFormData] = useState({
      name: '',
      position: '',
      qualification: '',
      phone: '',
      email: '',
      experience: '',
      coverLetter: '',
      region_id: ''
    });

    return (
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add New Applicant" size="lg">
        <div className="space-y-4">
          {!isSuperAdmin && userRegion && (
            <div className="p-3 rounded-lg bg-[#E8EDF5] text-sm text-slate-700">
              Applicant will be considered for <strong>{userRegion.name}</strong> region
            </div>
          )}
          {isSuperAdmin && (
            <div>
              <label htmlFor="applicantRegion" className="block text-sm font-medium text-slate-700 mb-1.5">Region *</label>
              <select
                id="applicantRegion"
                name="applicantRegion"
                value={formData.region_id}
                onChange={(e: any) => setFormData({...formData, region_id: e.target.value})}
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white"
                required
              >
                <option value="">-- Please select a region --</option>
                {regions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="applicantName" className="block text-sm font-medium text-slate-700 mb-1.5">Full Name *</label>
              <input 
                id="applicantName"
                name="applicantName"
                type="text" 
                value={formData.name} 
                onChange={(e: any) => setFormData({...formData, name: e.target.value})} 
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg" 
                required
              />
            </div>
            <div>
              <label htmlFor="applicantPosition" className="block text-sm font-medium text-slate-700 mb-1.5">Position Applied *</label>
              <input 
                id="applicantPosition"
                name="applicantPosition"
                type="text" 
                value={formData.position} 
                onChange={(e: any) => setFormData({...formData, position: e.target.value})} 
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg" 
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="applicantQualification" className="block text-sm font-medium text-slate-700 mb-1.5">Qualification</label>
              <input 
                id="applicantQualification"
                name="applicantQualification"
                type="text" 
                value={formData.qualification} 
                onChange={(e: any) => setFormData({...formData, qualification: e.target.value})} 
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg" 
              />
            </div>
            <div>
              <label htmlFor="applicantExperience" className="block text-sm font-medium text-slate-700 mb-1.5">Years of Experience</label>
              <input 
                id="applicantExperience"
                name="applicantExperience"
                type="text" 
                value={formData.experience} 
                onChange={(e: any) => setFormData({...formData, experience: e.target.value})} 
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg" 
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="applicantPhone" className="block text-sm font-medium text-slate-700 mb-1.5">Phone Number</label>
              <input 
                id="applicantPhone"
                name="applicantPhone"
                type="tel" 
                value={formData.phone} 
                onChange={(e: any) => setFormData({...formData, phone: e.target.value})} 
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg" 
              />
            </div>
            <div>
              <label htmlFor="applicantEmail" className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
              <input 
                id="applicantEmail"
                name="applicantEmail"
                type="email" 
                value={formData.email} 
                onChange={(e: any) => setFormData({...formData, email: e.target.value})} 
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg" 
              />
            </div>
          </div>
          <div>
            <label htmlFor="applicantCoverLetter" className="block text-sm font-medium text-slate-700 mb-1.5">Cover Letter</label>
            <textarea 
              id="applicantCoverLetter"
              name="applicantCoverLetter"
              rows={3}
              value={formData.coverLetter} 
              onChange={(e: any) => setFormData({...formData, coverLetter: e.target.value})}
              placeholder="Write a cover letter or notes about this applicant..."
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={() => setShowAddModal(false)} className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={() => addApplicant(formData)} disabled={!formData.name || !formData.position || (isSuperAdmin && !formData.region_id)} className="px-5 py-2 rounded-lg bg-[#D4A017] text-white text-sm font-semibold hover:bg-[#e8b82e] disabled:opacity-50">Add Applicant</button>
        </div>
      </Modal>
    );
  }, [showAddModal, isSuperAdmin, userRegion, regions, addApplicant]);

  // ===== RENDER =====
  if (loading) {
    return <div className="text-center py-8">Loading applicants...</div>;
  }

  const totalPages = Math.ceil(filtered.length / recruitmentItemsPerPage);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Recruitment Pipeline"
        subtitle={isSuperAdmin ? "Track applicants through the hiring workflow" : `${userRegion?.name || ''} Region - Recruitment`}
        actions={<Button variant="secondary" onClick={() => setShowAddModal(true)}><UserPlus size={16} /> New Applicant</Button>}
      />

      {!isSuperAdmin && userRegion && (
        <Card className="p-3 bg-gradient-to-r from-[#081C3A]/5 to-transparent border-[#081C3A]/20">
          <p className="text-sm text-slate-600">
            Managing recruitment for <strong className="text-[#081C3A]">{userRegion.name}</strong> region
          </p>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { l: 'Total', n: counts.total, color: 'navy' },
          { l: 'Shortlisted', n: counts.shortlisted, color: 'blue' },
          { l: 'Interviewed', n: counts.interviewed, color: 'gold' },
          { l: 'Accepted', n: counts.accepted, color: 'green' },
          { l: 'Rejected', n: counts.rejected, color: 'red' }
        ].map((s, i) => (
          <Card key={i} className="p-4">
            <p className="text-xs text-slate-500">{s.l}</p>
            <p className="text-2xl font-bold text-slate-800 mt-1">{s.n}</p>
          </Card>
        ))}
      </div>

      {/* Pipeline */}
      <Card className="p-5">
        <h3 className="font-semibold text-slate-800 mb-4">Application Pipeline</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { s: 'Pending', c: 'gray', n: applicants.filter(a => a.interview_status === 'Pending').length },
            { s: 'Shortlisted', c: 'blue', n: counts.shortlisted },
            { s: 'Interviewed', c: 'gold', n: counts.interviewed },
            { s: 'Accepted', c: 'green', n: counts.accepted },
            { s: 'Rejected', c: 'red', n: counts.rejected }
          ].map((p, i) => (
            <div key={i} className="p-4 rounded-lg border border-slate-100 text-center">
              <p className="text-3xl font-bold text-slate-800">{p.n}</p>
              <Badge color={p.c as any}>{p.s}</Badge>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4 flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input 
            id="searchApplicants"
            name="searchApplicants"
            type="text"
            value={search} 
            onChange={e => setSearch(e.target.value)} 
            placeholder="Search applicants..." 
            className="w-full pl-10 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#081C3A]" 
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {['all', 'pending', 'shortlisted', 'interviewed', 'accepted', 'rejected'].map(f => (
            <button 
              key={f} 
              type="button"
              onClick={() => setFilter(f)} 
              className={`px-3 py-2 text-xs font-medium rounded-lg ${filter === f ? 'bg-[#081C3A] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </Card>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <THead>
              <TR hover={false}>
                <TH>Applicant</TH>
                <TH>Position Applied</TH>
                <TH className="hidden md:table-cell">Qualification</TH>
                <TH>Interview Status</TH>
                <TH className="hidden md:table-cell">Applied</TH>
                <TH className="hidden lg:table-cell">Decision</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {paginatedApplicants.map(app => (
                <TR key={app.id}>
                  <TD>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#D4A017] flex items-center justify-center text-white text-xs font-bold shrink-0">{app.name.split(' ').map(n => n[0]).join('').slice(0, 2)}</div>
                      <div>
                        <p className="text-sm font-medium text-slate-800">{app.name}</p>
                        <p className="text-xs text-slate-500">{app.phone}</p>
                      </div>
                    </div>
                  </TD>
                  <TD>{app.position}</TD>
                  <TD className="hidden md:table-cell text-xs">{app.qualification}</TD>
                  <TD><Badge color={app.interview_status === 'Accepted' ? 'green' : app.interview_status === 'Rejected' ? 'red' : app.interview_status === 'Interviewed' ? 'gold' : app.interview_status === 'Shortlisted' ? 'blue' : 'gray'}>{app.interview_status}</Badge></TD>
                  <TD className="hidden md:table-cell text-xs">{app.application_date}</TD>
                  <TD className="hidden lg:table-cell"><Badge color={app.decision === 'Hire' ? 'green' : app.decision === 'Reject' ? 'red' : 'gray'}>{app.decision}</Badge></TD>
                  <TD className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button 
                        type="button"
                        onClick={() => handleViewApplicant(app)} 
                        className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-center"
                      >
                        <Eye size={14} />
                      </button>
                      <button 
                        type="button"
                        onClick={() => update(app.id, 'Shortlisted')} 
                        disabled={app.interview_status === 'Shortlisted'} 
                        className="px-2 py-1 text-xs rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                      >
                        Shortlist
                      </button>
                      <button 
                        type="button"
                        onClick={() => update(app.id, 'Interviewed')} 
                        disabled={app.interview_status === 'Interviewed'} 
                        className="px-2 py-1 text-xs rounded-md bg-[#FFF1CC] text-[#8B6F0F] hover:bg-[#F9E4B3] disabled:opacity-50"
                      >
                        Interview
                      </button>
                      <button 
                        type="button"
                        onClick={() => update(app.id, 'Accepted', 'Hire')} 
                        className="px-2 py-1 text-xs rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                      >
                        ✓ Hire
                      </button>
                      <button 
                        type="button"
                        onClick={() => update(app.id, 'Rejected', 'Reject')} 
                        className="px-2 py-1 text-xs rounded-md bg-red-50 text-red-700 hover:bg-red-100"
                      >
                        Reject
                      </button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </table>
        </div>
      </div>

      <Pagination
        currentPage={recruitmentPage}
        totalPages={totalPages}
        totalItems={filtered.length}
        itemsPerPage={recruitmentItemsPerPage}
        onPageChange={setRecruitmentPage}
        onItemsPerPageChange={setRecruitmentItemsPerPage}
      />

      {/* View Applicant Modal */}
      <Modal open={!!view} onClose={() => setView(null)} title="Applicant Details">
        {view && (
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="w-16 h-16 rounded-2xl bg-[#081C3A] flex items-center justify-center text-white text-xl font-bold shrink-0">{view.name.split(' ').map(n => n[0]).join('').slice(0, 2)}</div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-slate-800">{view.name}</h3>
                <p className="text-sm text-slate-500">{view.position}</p>
                <div className="flex items-center gap-2 mt-2">
                  <Badge color="gold">{view.qualification}</Badge>
                  <Badge color={view.interview_status === 'Accepted' ? 'green' : 'blue'}>{view.interview_status}</Badge>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-slate-500 text-xs">Phone</p><p className="font-medium">{view.phone}</p></div>
              <div><p className="text-slate-500 text-xs">Email</p><p className="font-medium">{view.email}</p></div>
              <div><p className="text-slate-500 text-xs">Experience</p><p className="font-medium">{view.experience} years</p></div>
              <div><p className="text-slate-500 text-xs">Applied</p><p className="font-medium">{view.application_date}</p></div>
            </div>
            <div className="p-4 bg-slate-50 rounded-lg text-sm">
              <p className="font-semibold text-slate-800 mb-2">Cover Letter</p>
              <p className="text-slate-600">{view.cover_letter || 'No cover letter provided.'}</p>
            </div>
            <div className="flex flex-wrap gap-2 pt-4 border-t border-slate-100">
              <Button
                variant="outline"
                disabled={!view.cv_url}
                onClick={() => { if (view.cv_url) window.open(view.cv_url, '_blank', 'noopener,noreferrer'); }}
              >
                <FileText size={14} /> {view.cv_url ? 'View CV' : 'No CV Uploaded'}
              </Button>
              <Button type="button" onClick={() => { update(view.id, 'Shortlisted'); setView(null); }}><UserCheck size={14} /> Shortlist</Button>
              <Button variant="secondary" type="button" onClick={() => { update(view.id, 'Accepted', 'Hire'); setView(null); }}><CheckCircle2 size={14} /> Hire Employee</Button>
              <Button variant="danger" type="button" onClick={() => { update(view.id, 'Rejected', 'Reject'); setView(null); }}><XCircle size={14} /> Reject</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Called as a plain function, not <AddApplicantModal />: this
          "component" is a useCallback closure (depending on addApplicant,
          which changes identity whenever `applicants` updates). Rendering it
          as JSX would make React remount it -- and reset the in-progress
          form -- any time the applicants list refreshes while it's open. */}
      {AddApplicantModal()}
    </div>
  );
}

export default RecruitmentPage;