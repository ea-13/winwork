/**
 * The standard scope containers a GC starts from.
 *
 * An empty Scope of Work screen is the wrong place to begin. An estimator does
 * not invent the shape of division 22 every job — they start from what a
 * plumbing package always contains and then edit it against this project's
 * documents. Making them type that skeleton from scratch is both slow and
 * lossy, because the lines people forget to type are exactly the lines that
 * later show up as change orders.
 *
 * Two rules govern what is allowed in here:
 *
 *   1. NO QUANTITIES. Not one, not ever, not even a plausible default. A
 *      template quantity is a number nobody measured, and R1 exists precisely
 *      so an estimator never has to work out which numbers were real. Units
 *      are fine — a unit is a statement about how the work is bought, not about
 *      how much of it there is.
 *
 *   2. NO PRICES, and no benchmark ranges. Costing has its own step and its
 *      own rules.
 *
 * The context lines are the valuable half. A container called "Metal stud
 * framing" tells a sub almost nothing; the same container carrying "includes
 * deflection track at head of full-height partitions" and "firestopping at rated
 * assemblies is carried by the FP sub, not here" is a scope of work. Those lines
 * come in as origin PATTERN, and the outcome loop scores them like any other —
 * so a template line that never predicts anything gets found out.
 */

export type TemplateContext = {
  kind: 'INCLUSION' | 'EXCLUSION' | 'INTERFACE' | 'ASSUMPTION' | 'RISK' | 'BASIS_OF_DESIGN';
  text: string;
};

export type TemplateItem = {
  section: string | null;
  title: string;
  description: string;
  /** How the work is bought. Never how much of it there is. */
  unit: string | null;
  context: TemplateContext[];
};

export type TemplateDivision = {
  code: string;
  /** What the package gets called. */
  packageName: string;
  items: TemplateItem[];
};

export const SCOPE_TEMPLATE: TemplateDivision[] = [
  {
    code: '01',
    packageName: 'General Requirements',
    items: [
      {
        section: '01 50 00',
        title: 'Temporary facilities and controls',
        description: 'Site office, temporary power and water, fencing, sanitary facilities.',
        unit: 'LS',
        context: [
          {
            kind: 'ASSUMPTION',
            text: 'Duration is assumed to equal the contract programme. An extension of time extends this cost, and it is rarely re-priced when it does.',
          },
          {
            kind: 'INCLUSION',
            text: 'Consumption, not just the connection — temporary power and water are billed monthly for the length of the job.',
          },
          {
            kind: 'RISK',
            text: 'Temporary facilities are priced against a programme that then slips, and the overrun ends up as nobody’s line item.',
          },
        ],
      },
      {
        section: '01 71 23',
        title: 'Field engineering and layout',
        description: 'Survey control, layout for the trades, and the as-built record.',
        unit: 'LS',
        context: [
          {
            kind: 'INTERFACE',
            text: 'Whether each trade lays out its own work or works to GC control lines. Both answers are normal, and they cost differently.',
          },
          {
            kind: 'INCLUSION',
            text: 'The as-built record the owner is owed at closeout, kept as the work proceeds rather than reconstructed at the end.',
          },
        ],
      },
      {
        section: '01 74 00',
        title: 'Cleaning and waste management',
        description: 'Progressive clean, waste haulage and disposal, final clean to handover.',
        unit: 'LS',
        context: [
          {
            kind: 'RISK',
            text: 'Progressive clean is assumed to be each trade’s own and is then done by none of them. Name who owns it.',
          },
          {
            kind: 'INCLUSION',
            text: 'Final clean to handover standard, glass and floors included.',
          },
        ],
      },
    ],
  },
  {
    code: '02',
    packageName: 'Existing Conditions & Demolition',
    items: [
      {
        section: '02 41 19',
        title: 'Selective demolition',
        description: 'Remove existing construction shown to be demolished, and legally dispose.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Cutting, capping and making safe of services within the demolition area.' },
          { kind: 'INCLUSION', text: 'Dust partitions and protection of adjacent areas that remain in use.' },
          { kind: 'EXCLUSION', text: 'Hazardous material abatement — separately licensed and separately bid.' },
          { kind: 'INTERFACE', text: 'Who disconnects live services before demolition: this sub or the MEP trades. Name it, or both will assume the other.' },
          { kind: 'RISK', text: 'Demolition beyond what the drawings show, discovered once finishes are opened up.' },
        ],
      },
      {
        section: '02 82 13',
        title: 'Hazardous material abatement',
        description: 'Abatement of materials identified in the survey, with clearance testing.',
        unit: 'LS',
        context: [
          { kind: 'ASSUMPTION', text: 'A hazardous materials survey exists and is attached. Without one this cannot be priced and must not be guessed.' },
          { kind: 'INCLUSION', text: 'Clearance air monitoring and the written clearance report.' },
          { kind: 'RISK', text: 'Quantities found during abatement routinely exceed the survey.' },
        ],
      },
    ],
  },
  {
    code: '03',
    packageName: 'Concrete',
    items: [
      {
        section: '03 30 00',
        title: 'Cast-in-place concrete — foundations',
        description: 'Footings, stem walls and foundation elements per the structural drawings.',
        unit: 'CY',
        context: [
          { kind: 'INCLUSION', text: 'Formwork, placement, finishing, curing and stripping.' },
          { kind: 'INCLUSION', text: 'Setting of anchor bolts and embeds furnished under division 05.' },
          { kind: 'EXCLUSION', text: 'Excavation and engineered fill — carried under division 31.' },
          { kind: 'INTERFACE', text: 'Under-slab plumbing, conduit and vapour barrier are installed by others before the pour; sequencing belongs to the GC.' },
          { kind: 'RISK', text: 'Over-excavation and the extra concrete to fill it is the most common foundation change order.' },
        ],
      },
      {
        section: '03 30 00',
        title: 'Slab on grade',
        description: 'Interior slab on grade, including finish and joint layout.',
        unit: 'SF',
        context: [
          { kind: 'INCLUSION', text: 'Saw-cut control joints, joint filler and the specified surface finish.' },
          { kind: 'ASSUMPTION', text: 'Vapour barrier and sub-base are in place and accepted before placement.' },
          { kind: 'INTERFACE', text: 'Floor flatness tolerance where resilient or thin-set finishes follow — the finish trade will reject a slab that meets a lesser spec.' },
        ],
      },
    ],
  },
  {
    code: '04',
    packageName: 'Masonry',
    items: [
      {
        section: '04 20 00',
        title: 'Unit masonry',
        description: 'CMU and brick, with reinforcing, grout and accessories.',
        unit: 'SF',
        context: [
          {
            kind: 'INCLUSION',
            text: 'Reinforcing, grout, ties, flashing and weeps — the accessories are most of the difference between two masonry numbers.',
          },
          {
            kind: 'INTERFACE',
            text: 'Lintels and loose steel: furnished under division 05, set by this trade. If neither party says so, they are furnished by nobody.',
          },
          {
            kind: 'ASSUMPTION',
            text: 'Scaffold and access are carried here unless stated otherwise. It is a large cost and it is routinely assumed to be the GC’s.',
          },
        ],
      },
    ],
  },
  {
    code: '05',
    packageName: 'Metals',
    items: [
      {
        section: '05 12 00',
        title: 'Structural steel',
        description: 'Fabricate, deliver and erect structural steel per the structural drawings.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Shop drawings, connection design where delegated, and shop primer.' },
          { kind: 'INCLUSION', text: 'Anchor bolts and embeds furnished to the concrete trade for setting.' },
          { kind: 'EXCLUSION', text: 'Fireproofing of structural members — carried under division 07.' },
          { kind: 'INTERFACE', text: 'Who furnishes versus who sets anchor bolts. This split is the classic division 03/05 gap.' },
        ],
      },
      {
        section: '05 50 00',
        title: 'Metal fabrications',
        description: 'Miscellaneous metals: lintels, bollards, ladders, support angles and frames.',
        unit: 'LS',
        context: [
          { kind: 'RISK', text: 'Miscellaneous metals is where scope nobody else claimed collects. Read the drawings for support steel that no other trade priced.' },
          { kind: 'INCLUSION', text: 'Support framing for equipment shown on the mechanical and electrical drawings but not detailed there.' },
        ],
      },
    ],
  },
  {
    code: '06',
    packageName: 'Rough & Finish Carpentry',
    items: [
      {
        section: '06 10 00',
        title: 'Rough carpentry',
        description: 'Wood framing, sheathing, blocking and backing.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Blocking and backing for wall-hung items: grab bars, casework, TVs, handrails, toilet accessories.' },
          { kind: 'RISK', text: 'Backing is the single most commonly forgotten item on a job. If it is not written down here, nobody carries it and it is found at rough inspection.' },
          { kind: 'INTERFACE', text: 'Backing locations come from the trades that hang things — accessories, casework, equipment. Coordinate before the walls close.' },
        ],
      },
      {
        section: '06 40 00',
        title: 'Architectural woodwork and casework',
        description: 'Shop-fabricated casework, countertops and trim.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Field measure, shop drawings, delivery and installation.' },
          { kind: 'EXCLUSION', text: 'Plumbing fixtures and cut-outs made on site by the plumbing trade.' },
          { kind: 'INTERFACE', text: 'Countertop cut-outs for sinks: fabricator cuts, plumber sets. Say which.' },
        ],
      },
    ],
  },
  {
    code: '07',
    packageName: 'Thermal & Moisture Protection',
    items: [
      {
        section: '07 21 00',
        title: 'Thermal insulation',
        description: 'Wall, floor and roof insulation per the energy compliance documents.',
        unit: 'SF',
        context: [
          { kind: 'BASIS_OF_DESIGN', text: 'Assemblies and R-values as shown on the energy compliance sheets, which govern over general notes.' },
          { kind: 'INCLUSION', text: 'Acoustic insulation at rated and sound-rated partitions where scheduled.' },
        ],
      },
      {
        section: '07 50 00',
        title: 'Roofing and flashing',
        description: 'Roof membrane or covering, flashing, and roof-related sheet metal.',
        unit: 'SF',
        context: [
          { kind: 'INCLUSION', text: 'Flashing at all roof penetrations, including those made by other trades.' },
          { kind: 'INTERFACE', text: 'Curbs for mechanical equipment: furnished by the mechanical trade, flashed by this one. Both assume the other seals it.' },
          { kind: 'RISK', text: 'Penetrations added after the membrane is on, and who pays to flash them.' },
        ],
      },
      {
        section: '07 84 00',
        title: 'Firestopping',
        description: 'Firestopping of penetrations and joints in rated assemblies.',
        unit: 'LS',
        context: [
          { kind: 'RISK', text: 'Firestopping is carried by nobody on a majority of jobs. Every trade assumes the trade that made the penetration seals it, and the drawings rarely say.' },
          { kind: 'INTERFACE', text: 'Head-of-wall joints at rated partitions: framer builds, this scope seals. Name the party or it will be found at inspection.' },
          { kind: 'INCLUSION', text: 'Penetrations made by mechanical, electrical, plumbing and low-voltage trades.' },
        ],
      },
    ],
  },
  {
    code: '08',
    packageName: 'Doors, Frames & Glazing',
    items: [
      {
        section: '08 10 00',
        title: 'Doors, frames and hardware',
        description: 'Doors, frames and finish hardware per the door schedule.',
        unit: 'EA',
        context: [
          { kind: 'BASIS_OF_DESIGN', text: 'The door and hardware schedules on the drawings govern. Where the schedule and the specification differ, the difference is a question, not a choice to make quietly.' },
          { kind: 'INCLUSION', text: 'Keying, cylinders and the keying conference.' },
          { kind: 'INTERFACE', text: 'Electrified hardware: this scope furnishes, division 26 or 28 powers and connects. The split is a routine gap.' },
        ],
      },
      {
        section: '08 40 00',
        title: 'Storefront and glazing',
        description: 'Aluminium storefront, entrances and glazing.',
        unit: 'SF',
        context: [
          { kind: 'INCLUSION', text: 'Perimeter sealant and backer rod at the storefront interface.' },
          { kind: 'INTERFACE', text: 'Waterproofing continuity between storefront and the wall assembly — the seam where water actually gets in.' },
        ],
      },
    ],
  },
  {
    code: '09',
    packageName: 'Finishes',
    items: [
      {
        section: '09 21 16',
        title: 'Metal stud framing and gypsum board',
        description: 'Interior partitions: framing, sheathing, hanging and finishing.',
        unit: 'SF',
        context: [
          { kind: 'INCLUSION', text: 'Deflection track at the head of full-height partitions.' },
          { kind: 'INCLUSION', text: 'Corner bead, trim and the specified level of finish.' },
          { kind: 'ASSUMPTION', text: 'Stud gauge and spacing as scheduled. A quote priced on 25ga against a 20ga schedule is not comparable.' },
          { kind: 'EXCLUSION', text: 'Firestopping at rated head-of-wall conditions — carried under division 07.' },
          { kind: 'INTERFACE', text: 'In-wall blocking and backing: who furnishes and who installs.' },
          { kind: 'RISK', text: 'Level of finish is the most common source of a finishes dispute. If the drawings do not state it, ask before bidding.' },
        ],
      },
      {
        section: '09 51 00',
        title: 'Acoustical ceilings',
        description: 'Suspended acoustical ceiling grid and tile.',
        unit: 'SF',
        context: [
          { kind: 'INCLUSION', text: 'Grid, tile, hanger wire and perimeter trim.' },
          { kind: 'INTERFACE', text: 'Seismic bracing of the grid, and who carries it — frequently drawn but not scoped.' },
          { kind: 'EXCLUSION', text: 'Support of light fixtures and diffusers independent of the grid, where required by code.' },
        ],
      },
      {
        section: '09 65 00',
        title: 'Resilient flooring and base',
        description: 'Resilient flooring, transitions and wall base.',
        unit: 'SF',
        context: [
          { kind: 'ASSUMPTION', text: 'Slab moisture is within the manufacturer tolerance. Testing and any mitigation are a separate cost nobody carries by default.' },
          { kind: 'RISK', text: 'Floor preparation — levelling, patching, grinding — is the standard resilient flooring change order.' },
          { kind: 'INCLUSION', text: 'Transition strips at every change of material.' },
        ],
      },
      {
        section: '09 91 00',
        title: 'Painting and coatings',
        description: 'Field painting of walls, ceilings, doors, frames and exposed work.',
        unit: 'SF',
        context: [
          { kind: 'INCLUSION', text: 'Priming and finish coats per the schedule, including doors and frames.' },
          { kind: 'INTERFACE', text: 'Painting of exposed structure, ductwork and conduit where scheduled — often assumed to be shop-finished and it is not.' },
        ],
      },
    ],
  },
  {
    code: '10',
    packageName: 'Specialties',
    items: [
      {
        section: '10 28 00',
        title: 'Toilet accessories and partitions',
        description: 'Washroom accessories, partitions and grab bars per the schedule.',
        unit: 'EA',
        context: [
          { kind: 'INTERFACE', text: 'Backing for accessories and grab bars is installed under division 06 and must be located before walls close.' },
          { kind: 'INCLUSION', text: 'Accessible-height mounting per the accessibility drawings.' },
        ],
      },
      {
        section: '10 44 00',
        title: 'Fire protection specialties',
        description: 'Extinguishers, cabinets and signage.',
        unit: 'EA',
        context: [
          { kind: 'RISK', text: 'Routinely omitted from every package and found at final inspection.' },
        ],
      },
    ],
  },
  {
    code: '11',
    packageName: 'Equipment',
    items: [
      {
        section: '11 00 00',
        title: 'Owner and contractor equipment',
        description: 'Equipment per the schedule, set in place with connections and commissioning.',
        unit: 'EA',
        context: [
          {
            kind: 'ASSUMPTION',
            text: 'Which items are owner-furnished. This one answer moves the price more than anything else on the line.',
          },
          {
            kind: 'INTERFACE',
            text: 'Rough-in for owner-furnished equipment: whose dimensions are used, and who carries the cost when they turn out to be wrong.',
          },
          {
            kind: 'RISK',
            text: 'Owner-furnished equipment arriving late, or not matching the rough-in, is a schedule and cost claim waiting to be written.',
          },
        ],
      },
    ],
  },
  {
    code: '12',
    packageName: 'Furnishings',
    items: [
      {
        section: '12 20 00',
        title: 'Window treatments',
        description: 'Blinds, shades and hardware per the schedule.',
        unit: 'EA',
        context: [
          {
            kind: 'INTERFACE',
            text: 'Blocking and shade pockets are built under division 06 or 09 and must be located before ceilings close.',
          },
        ],
      },
      {
        section: '12 30 00',
        title: 'Casework and countertops',
        description: 'Manufactured casework, tops, and hardware.',
        unit: 'LF',
        context: [
          {
            kind: 'EXCLUSION',
            text: 'Plumbing and electrical connections — carried under 22 and 26.',
          },
          {
            kind: 'INTERFACE',
            text: 'Sink and fixture cut-outs: the fabricator cuts, the plumber sets. Say which, because both assume the other.',
          },
        ],
      },
    ],
  },
  {
    code: '13',
    packageName: 'Special Construction',
    items: [
      {
        section: '13 34 00',
        title: 'Pre-engineered structures',
        description: 'Pre-engineered building or enclosure, delivered and erected.',
        unit: 'LS',
        context: [
          {
            kind: 'INCLUSION',
            text: 'Engineering, stamped drawings, and the deferred submittal package.',
          },
          {
            kind: 'INTERFACE',
            text: 'Anchor bolts and foundations: the supplier provides reactions, the foundation is designed and built under division 03.',
          },
          {
            kind: 'RISK',
            text: 'Long lead. The delivery date a supplier gives at bid time is rarely the one that holds.',
          },
        ],
      },
    ],
  },
  {
    code: '14',
    packageName: 'Conveying Equipment',
    items: [
      {
        section: '14 20 00',
        title: 'Elevators',
        description: 'Elevator supply, installation, testing and certification.',
        unit: 'EA',
        context: [
          {
            kind: 'EXCLUSION',
            text: 'Hoistway construction, pit waterproofing and the machine room — carried by the building trades, not here.',
          },
          {
            kind: 'INTERFACE',
            text: 'Power, lighting, telephone and fire alarm recall into the hoistway: divisions 26 and 28.',
          },
          {
            kind: 'RISK',
            text: 'Inspection and certification scheduling sits outside everyone’s control and routinely holds up handover.',
          },
        ],
      },
    ],
  },
  {
    code: '21',
    packageName: 'Fire Suppression',
    items: [
      {
        section: '21 13 00',
        title: 'Fire sprinkler system',
        description: 'Design-build sprinkler system, permitted and tested.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Hydraulic calculations, shop drawings, permit and the final acceptance test.' },
          { kind: 'INTERFACE', text: 'Head locations coordinated with the ceiling grid and lighting layout, not just the reflected ceiling plan.' },
          { kind: 'EXCLUSION', text: 'Fire alarm devices and monitoring — carried under division 28.' },
          { kind: 'ASSUMPTION', text: 'Available water supply is adequate. A flow test that comes back short changes the whole system design.' },
        ],
      },
    ],
  },
  {
    code: '22',
    packageName: 'Plumbing',
    items: [
      {
        section: '22 11 00',
        title: 'Domestic water distribution',
        description: 'Water service, distribution piping, valves and insulation.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Water service from the point of connection, meter fittings, shut-off and hose bibs.' },
          { kind: 'INTERFACE', text: 'Trenching and backfill for the service line: frequently excluded by the plumber and assumed by nobody.' },
          { kind: 'ASSUMPTION', text: 'Pipe material and type as specified. Copper type L and PEX are not the same bid.' },
          { kind: 'INCLUSION', text: 'Pipe insulation where required by the energy code.' },
        ],
      },
      {
        section: '22 13 00',
        title: 'Sanitary waste and vent',
        description: 'Waste, vent and drainage piping to the point of connection.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Under-slab rough-in, testing and inspection prior to the pour.' },
          { kind: 'INTERFACE', text: 'Sequencing with the slab: under-slab rough must be inspected before concrete, and that is a GC scheduling obligation.' },
          { kind: 'EXCLUSION', text: 'Site utilities beyond five feet of the building — carried under division 33.' },
        ],
      },
      {
        section: '22 40 00',
        title: 'Plumbing fixtures',
        description: 'Fixtures, trim and final connections per the fixture schedule.',
        unit: 'EA',
        context: [
          { kind: 'ASSUMPTION', text: 'Whether fixtures are contractor-furnished or owner-furnished. A quote priced on customer-supplied fixtures is not comparable to one that includes them.' },
          { kind: 'INCLUSION', text: 'Supplies, stops, traps and final connections.' },
          { kind: 'INTERFACE', text: 'Countertop and casework cut-outs, and who makes them.' },
          { kind: 'RISK', text: 'Customer-supplied fixtures usually carry no warranty from the installer. That is a real exposure, not a footnote.' },
        ],
      },
      {
        section: '22 33 00',
        title: 'Water heating',
        description: 'Water heater, connections, venting and seismic restraint.',
        unit: 'EA',
        context: [
          { kind: 'ASSUMPTION', text: 'Furnished by contractor or by owner. State it — this single line moves the comparison.' },
          { kind: 'INCLUSION', text: 'Expansion tank, pressure relief piping and seismic strapping where required.' },
          { kind: 'INTERFACE', text: 'Electrical or gas connection to the unit, and which trade carries it.' },
        ],
      },
    ],
  },
  {
    code: '23',
    packageName: 'HVAC',
    items: [
      {
        section: '23 30 00',
        title: 'Air distribution',
        description: 'Ductwork, diffusers, grilles and registers.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Duct insulation, sealing and the specified leakage class.' },
          { kind: 'INTERFACE', text: 'Roof and wall penetrations: made by this trade, flashed under division 07.' },
          { kind: 'INCLUSION', text: 'Test and balance, with a written report.' },
        ],
      },
      {
        section: '23 60 00',
        title: 'Heating and cooling equipment',
        description: 'Equipment, curbs, connections and start-up.',
        unit: 'EA',
        context: [
          { kind: 'INCLUSION', text: 'Equipment curbs furnished to the roofing trade, start-up and commissioning.' },
          { kind: 'INTERFACE', text: 'Power and control wiring: which of division 23 and 26 carries line voltage, and which carries controls.' },
          { kind: 'RISK', text: 'Structural support for rooftop units is regularly assumed to be someone else.' },
        ],
      },
    ],
  },
  {
    code: '25',
    packageName: 'Integrated Automation',
    items: [
      {
        section: '25 00 00',
        title: 'Building controls',
        description: 'Control system, field points, programming, graphics and checkout.',
        unit: 'LS',
        context: [
          {
            kind: 'INTERFACE',
            text: 'Which points are furnished by the mechanical trade and which are wired here. This split is where controls scope disappears.',
          },
          {
            kind: 'INCLUSION',
            text: 'Point-to-point checkout, and the witnessed test the commissioning agent will ask for.',
          },
          {
            kind: 'ASSUMPTION',
            text: 'Whether the network and head-end are owner IT or carried here.',
          },
        ],
      },
    ],
  },
  {
    code: '26',
    packageName: 'Electrical',
    items: [
      {
        section: '26 05 00',
        title: 'Electrical rough-in and distribution',
        description: 'Service, panels, feeders, branch circuits and devices.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Permits, utility coordination and the final inspection.' },
          { kind: 'INTERFACE', text: 'Equipment connections for mechanical and plumbing equipment: furnished by those trades, connected by this one. Say where the line is.' },
          { kind: 'INCLUSION', text: 'Firestopping of this trade penetrations, unless carried under division 07 — do not let both exclude it.' },
        ],
      },
      {
        section: '26 50 00',
        title: 'Lighting and controls',
        description: 'Luminaires, lamps, controls and the code-required control sequences.',
        unit: 'EA',
        context: [
          { kind: 'BASIS_OF_DESIGN', text: 'Fixture schedule governs. Substitutions change the energy compliance calculation.' },
          { kind: 'INCLUSION', text: 'Controls, sensors and the acceptance testing required by the energy code.' },
          { kind: 'RISK', text: 'Lighting control acceptance testing is a specialist scope routinely priced by nobody.' },
        ],
      },
    ],
  },
  {
    code: '27',
    packageName: 'Communications',
    items: [
      {
        section: '27 10 00',
        title: 'Structured cabling',
        description: 'Data cabling, racks, patch panels, labelling and certification.',
        unit: 'EA',
        context: [
          {
            kind: 'INCLUSION',
            text: 'Testing and certification of every drop, with the report handed over.',
          },
          {
            kind: 'INTERFACE',
            text: 'Pathways, conduit and backboxes: division 26 or here. Both trades routinely exclude it.',
          },
          {
            kind: 'ASSUMPTION',
            text: 'Whether active equipment is owner-supplied. Usually it is, and usually nobody wrote that down.',
          },
        ],
      },
    ],
  },
  {
    code: '28',
    packageName: 'Fire Alarm & Security',
    items: [
      {
        section: '28 31 00',
        title: 'Fire alarm system',
        description: 'Devices, panel, programming, permit and acceptance test.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Shop drawings, permit, programming and the witnessed acceptance test.' },
          { kind: 'INTERFACE', text: 'Sprinkler flow and tamper switches: furnished under division 21, wired and monitored here.' },
          { kind: 'INTERFACE', text: 'Elevator recall and HVAC shutdown interfaces, where those systems exist.' },
        ],
      },
    ],
  },
  {
    code: '31',
    packageName: 'Earthwork',
    items: [
      {
        section: '31 20 00',
        title: 'Earthwork and grading',
        description: 'Excavation, engineered fill, compaction and rough grading.',
        unit: 'CY',
        context: [
          { kind: 'ASSUMPTION', text: 'Soil conditions per the geotechnical report. Without one, this is unpriceable rather than cheap.' },
          { kind: 'EXCLUSION', text: 'Rock excavation, dewatering and export of unsuitable material, unless stated.' },
          { kind: 'RISK', text: 'Unsuitable soils and export are the largest earthwork change orders on almost every job.' },
          { kind: 'INCLUSION', text: 'Compaction testing coordination, with results provided.' },
        ],
      },
      {
        section: '31 10 00',
        title: 'Site clearing and erosion control',
        description: 'Clearing, demolition of site features, and erosion control measures.',
        unit: 'LS',
        context: [
          { kind: 'INCLUSION', text: 'Installation and ongoing maintenance of erosion control through the job.' },
          { kind: 'RISK', text: 'Maintenance of erosion control for the whole project duration is priced as installation only more often than not.' },
        ],
      },
    ],
  },
  {
    code: '32',
    packageName: 'Exterior Improvements',
    items: [
      {
        section: '32 12 00',
        title: 'Paving',
        description: 'Asphalt or concrete paving, base course, and striping.',
        unit: 'SF',
        context: [
          {
            kind: 'INCLUSION',
            text: 'Base preparation, compaction testing, and striping.',
          },
          {
            kind: 'ASSUMPTION',
            text: 'Subgrade accepted as found. Remediation is extra, and it is the most common paving claim there is.',
          },
          {
            kind: 'INTERFACE',
            text: 'Accessible routes and slopes: a failed inspection here is a rebuild, not a repair.',
          },
        ],
      },
      {
        section: '32 90 00',
        title: 'Landscaping and irrigation',
        description: 'Planting, irrigation, and the establishment period.',
        unit: 'LS',
        context: [
          {
            kind: 'INCLUSION',
            text: 'The establishment or maintenance period — it is a duration, and it is a real cost.',
          },
          {
            kind: 'INTERFACE',
            text: 'Irrigation point of connection and backflow prevention: division 22 or here.',
          },
        ],
      },
    ],
  },
  {
    code: '33',
    packageName: 'Site Utilities',
    items: [
      {
        section: '33 10 00',
        title: 'Site utilities',
        description: 'Water, sewer, storm and dry utilities from the point of connection to the building.',
        unit: 'LF',
        context: [
          { kind: 'INTERFACE', text: 'Where site utilities stop and building plumbing starts. Five feet from the building is the convention; the drawings may say otherwise, and the two subs will not agree by themselves.' },
          { kind: 'INCLUSION', text: 'Trenching, bedding, backfill, compaction and surface restoration.' },
          { kind: 'ASSUMPTION', text: 'Utility company connection fees and their schedule are excluded unless stated.' },
        ],
      },
    ],
  },
];

export const templateFor = (code: string): TemplateDivision | undefined =>
  SCOPE_TEMPLATE.find((division) => division.code === code);
