import { useState, useEffect } from 'react';
import { Map, Building2, ClipboardList, Car, Bot, Camera, Sparkles, Smartphone } from 'lucide-react';
import { Card, Button, Badge, PageHeader } from '../components/ui';
import { supabase } from '../lib/supabase';
// ===== Import audit logger =====
import { logAudit } from '../utils/auditLogger';

export function FeaturesPage() {
  const [userProfile, setUserProfile] = useState<any>(null);

  // Fetch user profile for audit logging
  useEffect(() => {
    const fetchUserProfile = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('*, regions(*)')
          .eq('id', user.id)
          .single();
        setUserProfile(profile);
      }
    };
    fetchUserProfile();
  }, []);

  // ===== Audit log for viewing the Features page =====
  useEffect(() => {
    const logFeaturesView = async () => {
      if (userProfile) {
        await logAudit({
          action: 'VIEW',
          entity_type: 'features_page',
          new_data: {
            page: 'Future Features Roadmap',
            timestamp: new Date().toISOString(),
            user_role: userProfile?.role_level,
            is_super_admin: userProfile?.is_super_admin
          },
          region_id: userProfile?.region_id
        });
      }
    };
    
    logFeaturesView();
  }, [userProfile]);

  const features = [
    { title: 'AI-Powered Analytics', desc: 'Predictive insights for workforce management', icon: Bot, color: 'purple' },
    { title: 'Mobile App', desc: 'Employee self-service portal for attendance and payslips', icon: Smartphone, color: 'blue' },
    { title: 'Biometric Integration', desc: 'Fingerprint and facial recognition for attendance', icon: Camera, color: 'emerald' },
    { title: 'Fleet Management', desc: 'Track security vehicles and patrol routes', icon: Car, color: 'gold' },
    { title: 'Client Portal', desc: 'Real-time reporting for client companies', icon: Building2, color: 'navy' },
    { title: 'Document Management', desc: 'Digital storage for employee contracts and certificates', icon: ClipboardList, color: 'red' }
  ];
  
  const colorMap: Record<string, string> = {
    navy: 'from-[#081C3A] to-[#1a2f5c]',
    gold: 'from-[#8B6F0F] to-[#D4A017]',
    red: 'from-[#7F1D1D] to-[#EF4444]',
    blue: 'from-[#1E40AF] to-[#3B82F6]',
    purple: 'from-[#5B21B6] to-[#8B5CF6]',
    emerald: 'from-[#065F46] to-[#10B981]'
  };
  
  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader 
        title="Future Features Roadmap" 
        subtitle="Upcoming enhancements and planned features" 
      />
      
      <Card className="p-6 bg-gradient-to-br from-[#081C3A] to-[#1a2f5c] text-white border-0">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-[#D4A017] flex items-center justify-center">
            <Sparkles size={28} className="text-[#081C3A]" />
          </div>
          <div>
            <h2 className="text-2xl font-bold mb-2">Scaling to 1,000+ Employees</h2>
            <p className="text-white/80">Enterprise-ready architecture for future growth</p>
            <div className="flex gap-2 mt-3">
              <Badge color="gold">Q1 2026</Badge>
              <Badge color="blue">In Development</Badge>
            </div>
          </div>
        </div>
      </Card>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {features.map((f, i) => {
          const Icon = f.icon;
          return (
            <Card key={i} className="overflow-hidden hover:shadow-lg transition-shadow">
              <div className={`h-2 bg-gradient-to-r ${colorMap[f.color]}`} />
              <div className="p-6">
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${colorMap[f.color]} flex items-center justify-center text-white mb-4`}>
                  <Icon size={22} />
                </div>
                <h3 className="text-lg font-bold text-slate-800 mb-2">{f.title}</h3>
                <p className="text-sm text-slate-600 mb-3">{f.desc}</p>
                <Badge color="gold">Coming Soon</Badge>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export default FeaturesPage;