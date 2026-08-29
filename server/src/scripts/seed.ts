/**
 * Seeds the demo tenant. Run with `npm run seed` from the repo root.
 *
 * Uses the service_role client, so it bypasses RLS — this is the one place
 * that is legitimate, because there is no authenticated user yet.
 *
 * Idempotent: every row's primary key is derived from a stable string, so
 * re-running upserts the same rows rather than duplicating them.
 */
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';

// -----------------------------------------------------------------------------
// Deterministic ids
// -----------------------------------------------------------------------------

const NAMESPACE = 'winprojects.demo.seed.v1';

/** A UUIDv5-shaped id derived from a key, so re-running seeds the same rows. */
function stableId(key: string): string {
  const hash = createHash('sha1').update(`${NAMESPACE}:${key}`).digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const TENANT_ID = stableId('tenant');
const USER_ID = stableId('user:demo@winprojects.ai');
const PROJECT_ID = stableId('project:DEMO-2026-001');
const PACKAGE_ID = stableId('package:interior-finishes');

const BID_ID = 'DEMO-2026-001';
const now = new Date();
const dueAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

// -----------------------------------------------------------------------------
// Scope baseline — 18 items, already vetted and locked (H2 has been crossed)
// -----------------------------------------------------------------------------

type ScopeSeed = {
  section: string;
  title: string;
  description: string;
  unit: string;
  quantity: number;
  basis: string;
};

const SCOPE_ITEMS: ScopeSeed[] = [
  // Division 07 — Thermal and Moisture Protection
  {
    section: '07-14',
    title: 'Firestopping at penetrations',
    description:
      'Rated firestopping at all floor and wall penetrations, including sleeves and pathway devices.',
    unit: 'EA',
    quantity: 240,
    basis: 'Count from A-501 penetration schedule, rev 2',
  },
  {
    section: '07-21',
    title: 'Building insulation',
    description: 'Batt insulation at interior partitions and above ceiling at demising walls.',
    unit: 'SF',
    quantity: 8400,
    basis: 'Takeoff A-201 through A-244, rev 2',
  },
  {
    section: '07-92',
    title: 'Joint sealants',
    description: 'Interior joint sealants at frames, penetrations and control joints.',
    unit: 'LF',
    quantity: 2100,
    basis: 'Takeoff A-201 through A-244, rev 2',
  },

  // Division 08 — Openings
  {
    section: '08-11',
    title: 'Hollow metal doors and frames',
    description: 'HM frames and doors including rated assemblies at corridors and exits.',
    unit: 'EA',
    quantity: 46,
    basis: 'Door schedule A-601, rev 3',
  },
  {
    section: '08-71',
    title: 'Door hardware',
    description: 'Finish hardware sets per schedule, including closers and exit devices.',
    unit: 'EA',
    quantity: 46,
    basis: 'Hardware schedule A-602, rev 3',
  },
  {
    section: '08-80',
    title: 'Interior glazing and borrowed lites',
    description: 'Interior glazing at borrowed lites, sidelites and relite frames.',
    unit: 'SF',
    quantity: 620,
    basis: 'Takeoff A-201 through A-244, rev 2',
  },

  // Division 09 — Finishes
  {
    section: '09-21',
    title: 'Metal stud framing and gypsum board',
    description:
      'Interior metal stud framing, gypsum board, taping and finish to Level 4 unless noted.',
    unit: 'SF',
    quantity: 24800,
    basis: 'Takeoff A-201 through A-244, rev 2',
  },
  {
    section: '09-51',
    title: 'Acoustical ceilings',
    description: 'Suspended acoustical ceiling grid and tile at offices, corridors and exam rooms.',
    unit: 'SF',
    quantity: 18200,
    basis: 'Reflected ceiling plans A-301 through A-318',
  },
  {
    section: '09-65',
    title: 'Resilient flooring',
    description: 'Luxury vinyl tile and resilient base at offices, corridors and support spaces.',
    unit: 'SF',
    quantity: 9600,
    basis: 'Finish plans A-401 through A-412',
  },
  {
    section: '09-67',
    title: 'Fluid-applied epoxy flooring',
    description:
      'Fluid-applied epoxy flooring with integral cove base at soiled utility and lab areas.',
    unit: 'SF',
    quantity: 2400,
    basis: 'Finish plans A-401 through A-412',
  },
  {
    section: '09-72',
    title: 'FRP wall protection',
    description: 'Fibreglass reinforced panel wall protection at soiled utility and janitor rooms.',
    unit: 'SF',
    quantity: 1850,
    basis: 'Finish plans A-401 through A-412',
  },
  {
    section: '09-91',
    title: 'Painting',
    description: 'Prime and finish paint at gypsum board, hollow metal and exposed structure.',
    unit: 'SF',
    quantity: 31000,
    basis: 'Takeoff A-201 through A-244, rev 2',
  },

  // Division 22 — Plumbing
  {
    section: '22-11',
    title: 'Domestic water piping',
    description: 'Domestic hot and cold water distribution within the tenant improvement area.',
    unit: 'LF',
    quantity: 1450,
    basis: 'Plumbing plans P-101 through P-112',
  },
  {
    section: '22-42',
    title: 'Plumbing fixtures',
    description: 'Fixtures, carriers and trim including exam room sinks and ADA lavatories.',
    unit: 'EA',
    quantity: 38,
    basis: 'Fixture schedule P-601',
  },

  // Division 23 — HVAC
  {
    section: '23-31',
    title: 'HVAC ductwork',
    description: 'Sheet metal supply, return and exhaust ductwork including hangers and sealing.',
    unit: 'LB',
    quantity: 12400,
    basis: 'Mechanical plans M-101 through M-118',
  },
  {
    section: '23-37',
    title: 'Air devices',
    description: 'Grilles, registers and diffusers including balancing dampers.',
    unit: 'EA',
    quantity: 96,
    basis: 'Mechanical schedules M-601',
  },

  // Division 26 — Electrical
  {
    section: '26-05',
    title: 'Branch wiring and conduit',
    description: 'Branch circuit conduit and conductors for power and equipment connections.',
    unit: 'LF',
    quantity: 6200,
    basis: 'Electrical plans E-101 through E-120',
  },
  {
    section: '26-51',
    title: 'Interior lighting',
    description: 'Interior lighting fixtures, drivers and controls at all tenant areas.',
    unit: 'EA',
    quantity: 214,
    basis: 'Lighting plans E-201 through E-214',
  },
];

/**
 * The Interior Finishes package. Division 09 plus 07-14 firestopping, which a
 * GC commonly carries in the interior package rather than with the division 07
 * envelope trades — and which is the planted UNCOVERED gap: no bidder on this
 * package prices it.
 */
const PACKAGE_SECTIONS = ['07-14', '09-21', '09-51', '09-65', '09-67', '09-72', '09-91'];

// -----------------------------------------------------------------------------
// Subcontractors
// -----------------------------------------------------------------------------

type SubSeed = {
  name: string;
  trades: string[];
  contact: string;
  email: string;
  licenseNo: string;
  licenseClass: string;
  bonding: number;
  emr: number;
  prequal: string;
};

const SUBCONTRACTORS: SubSeed[] = [
  { name: 'Meridian Interiors LLC', trades: ['09'], contact: 'Dana Whitfield', email: 'estimating@meridianinteriors.example', licenseNo: '# 884201', licenseClass: 'C-9', bonding: 8_000_000, emr: 0.78, prequal: 'APPROVED' },
  { name: 'Cascade Drywall & Acoustics', trades: ['09'], contact: 'Ruben Ortiz', email: 'bids@cascadedrywall.example', licenseNo: '# 771540', licenseClass: 'C-9', bonding: 6_500_000, emr: 0.85, prequal: 'APPROVED' },
  { name: 'Ironwood Framing Systems', trades: ['05', '09'], contact: 'Priya Raman', email: 'preconstruction@ironwoodframing.example', licenseNo: '# 690118', licenseClass: 'B', bonding: 12_000_000, emr: 0.91, prequal: 'APPROVED' },
  { name: 'Pinnacle Painting Co.', trades: ['09'], contact: 'Grace Yoon', email: 'bids@pinnaclepainting.example', licenseNo: '# 512338', licenseClass: 'C-33', bonding: 3_000_000, emr: 0.72, prequal: 'APPROVED' },
  { name: 'Sierra Flooring Group', trades: ['09'], contact: 'Marcus Hale', email: 'estimating@sierraflooring.example', licenseNo: '# 803977', licenseClass: 'C-15', bonding: 5_000_000, emr: 0.88, prequal: 'APPROVED' },
  { name: 'Apex Epoxy & Coatings', trades: ['09'], contact: 'Tomas Berger', email: 'bids@apexepoxy.example', licenseNo: '# 745002', licenseClass: 'C-15', bonding: 2_500_000, emr: 0.95, prequal: 'CONDITIONAL' },
  { name: 'Guardian Firestop Systems', trades: ['07'], contact: 'Alina Kovač', email: 'estimating@guardianfirestop.example', licenseNo: '# 668410', licenseClass: 'C-16', bonding: 4_000_000, emr: 0.81, prequal: 'APPROVED' },
  { name: 'Summit Insulation Contractors', trades: ['07'], contact: 'Errol Danforth', email: 'bids@summitinsulation.example', licenseNo: '# 592264', licenseClass: 'C-2', bonding: 3_500_000, emr: 0.9, prequal: 'APPROVED' },
  { name: 'Clearview Glass & Glazing', trades: ['08'], contact: 'Nadia Fournier', email: 'estimating@clearviewglass.example', licenseNo: '# 731885', licenseClass: 'C-17', bonding: 4_500_000, emr: 0.83, prequal: 'APPROVED' },
  { name: 'Northgate Door & Hardware', trades: ['08'], contact: 'Wes Calloway', email: 'bids@northgatedoor.example', licenseNo: '# 640712', licenseClass: 'C-6', bonding: 2_000_000, emr: 0.79, prequal: 'APPROVED' },
  { name: 'BlueRidge Mechanical', trades: ['22', '23'], contact: 'Helena Marsh', email: 'preconstruction@blueridgemech.example', licenseNo: '# 918663', licenseClass: 'C-20', bonding: 18_000_000, emr: 1.02, prequal: 'APPROVED' },
  { name: 'Voltline Electric', trades: ['26'], contact: 'Julius Okafor', email: 'estimating@voltlineelectric.example', licenseNo: '# 855129', licenseClass: 'C-10', bonding: 15_000_000, emr: 0.87, prequal: 'APPROVED' },
];

/**
 * Bidders on the Interior Finishes package. Guardian Firestop is deliberately
 * absent: nobody on this package prices 07-14, which is what makes it the
 * UNCOVERED gap the demo turns on.
 */
const PACKAGE_BIDDERS = [
  'Meridian Interiors LLC',
  'Cascade Drywall & Acoustics',
  'Sierra Flooring Group',
  'Pinnacle Painting Co.',
  'Apex Epoxy & Coatings',
];

// -----------------------------------------------------------------------------

function fail(step: string, error: { message: string } | null): void {
  if (error) {
    console.error(`  ${step} failed: ${error.message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log(`seeding demo tenant into ${new URL(process.env.SUPABASE_URL ?? '').host}\n`);

  const tenant = await supabaseAdmin
    .from('tenant')
    .upsert({ id: TENANT_ID, name: 'Demo Construction Co' });
  fail('tenant', tenant.error);

  const user = await supabaseAdmin.from('app_user').upsert({
    id: USER_ID,
    tenant_id: TENANT_ID,
    email: 'demo@winprojects.ai',
    display_name: 'Demo Estimator',
  });
  fail('app_user', user.error);

  // Roles are grants: a two-estimator GC has one person holding both.
  const roles = await supabaseAdmin.from('user_role').upsert(
    ['BC', 'EST'].map((role) => ({
      id: stableId(`role:${role}`),
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role,
    })),
  );
  fail('user_role', roles.error);

  const project = await supabaseAdmin.from('project').upsert({
    id: PROJECT_ID,
    tenant_id: TENANT_ID,
    bid_id: BID_ID,
    name: 'Riverside Medical Office TI',
    owner_org: 'Riverside Health',
    due_at: dueAt.toISOString(),
    status: 'BIDDING',
  });
  fail('project', project.error);

  // scope_id is {bid_id}-{csi_division}-{seq}, sequenced within its division.
  const perDivision = new Map<string, number>();
  const scopeRows = SCOPE_ITEMS.map((item) => {
    const division = item.section.slice(0, 2);
    const seq = (perDivision.get(division) ?? 0) + 1;
    perDivision.set(division, seq);
    const scopeId = `${BID_ID}-${division}-${String(seq).padStart(3, '0')}`;

    return {
      id: stableId(`scope:${scopeId}`),
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      scope_id: scopeId,
      csi_division: division,
      csi_section: item.section,
      title: item.title,
      description: item.description,
      unit: item.unit,
      quantity: item.quantity,
      quantity_basis: item.basis,
      is_locked: true, // scope is already vetted — H2 has been crossed
      locked_by: USER_ID,
      locked_at: now.toISOString(),
    };
  });

  const scope = await supabaseAdmin.from('scope_item').upsert(scopeRows);
  fail('scope_item', scope.error);

  const pkg = await supabaseAdmin.from('work_package').upsert({
    id: PACKAGE_ID,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    name: 'Interior Finishes',
    csi_divisions: ['07', '09'],
    status: 'APPROVED', // H3
    approved_by: USER_ID,
    approved_at: now.toISOString(),
  });
  fail('work_package', pkg.error);

  const packaged = scopeRows.filter((row) => PACKAGE_SECTIONS.includes(row.csi_section));
  const links = await supabaseAdmin.from('package_scope').upsert(
    packaged.map((row) => ({
      tenant_id: TENANT_ID,
      package_id: PACKAGE_ID,
      scope_item_id: row.id,
    })),
  );
  fail('package_scope', links.error);

  const subRows = SUBCONTRACTORS.map((sub) => ({
    id: stableId(`sub:${sub.name}`),
    tenant_id: TENANT_ID,
    name: sub.name,
    trade_csi: sub.trades,
    contact_name: sub.contact,
    contact_email: sub.email,
    license_no: sub.licenseNo,
    license_class: sub.licenseClass,
    bonding_capacity: sub.bonding,
    emr: sub.emr,
    prequal_status: sub.prequal,
    source: 'SEED',
    imported_at: now.toISOString(),
    raw_row: { seeded: true, name: sub.name },
  }));

  const subs = await supabaseAdmin.from('subcontractor').upsert(subRows);
  fail('subcontractor', subs.error);

  // invited_state stays CANDIDATE. Nothing here implies an invitation went out,
  // because no send path exists anywhere in this system (R3).
  const bidders = await supabaseAdmin.from('package_bidder').upsert(
    PACKAGE_BIDDERS.map((name) => ({
      id: stableId(`bidder:${name}`),
      tenant_id: TENANT_ID,
      package_id: PACKAGE_ID,
      subcontractor_id: stableId(`sub:${name}`),
      invited_state: 'CANDIDATE',
      list_approved_by: USER_ID,
      list_approved_at: now.toISOString(), // H4
    })),
  );
  fail('package_bidder', bidders.error);

  // ---------------------------------------------------------------------------

  const counts = await Promise.all(
    (['app_user', 'user_role', 'project', 'scope_item', 'work_package', 'package_scope', 'subcontractor', 'package_bidder'] as const).map(
      async (table) => {
        const { count } = await supabaseAdmin
          .from(table)
          .select('*', { count: 'exact', head: true })
          .eq('tenant_id', TENANT_ID);
        return [table, count ?? 0] as const;
      },
    ),
  );

  console.log('  tenant                Demo Construction Co');
  for (const [table, count] of counts) {
    console.log(`  ${table.padEnd(20)}  ${count}`);
  }
  console.log('\n  planted gaps: 07-14 firestopping (UNCOVERED, no bidder prices it)');
  console.log('                09-72 FRP wall protection (PARTIAL)');
  console.log('\nseed complete — safe to re-run');
}

await main();
