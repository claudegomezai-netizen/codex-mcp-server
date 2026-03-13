/**
 * Form ADV Analyzer — uses SEC IAPD (Investment Adviser Public Disclosure) API
 * Form ADV is filed through IARD, NOT EDGAR, so we query adviserinfo.sec.gov
 */

import type { FormAdvAnalysis } from '../config/competitors.js';
import { getAllEntitiesWithCustom, saveAdvAnalysis, logCrawl } from '../services/blobStore.js';

const IAPD_SEARCH = 'https://api.adviserinfo.sec.gov/search/firm';
const IAPD_FIRM = 'https://api.adviserinfo.sec.gov/search/firm';
const IAPD_SITE = 'https://adviserinfo.sec.gov';
const REPORTS_SITE = 'https://reports.adviserinfo.sec.gov';

interface IAPDHit {
  _source: {
    firm_source_id: string;
    firm_name: string;
    firm_other_names?: string[];
    firm_ia_scope?: string;
    firm_ia_sec_number?: string;
    firm_ia_full_sec_number?: string;
    firm_ia_disclosure_fl?: string;
    firm_branches_count?: number;
    firm_ia_address_details?: string;
  };
}

async function searchIAPD(entityName: string): Promise<IAPDHit | null> {
  try {
    const res = await fetch(
      `${IAPD_SEARCH}?query=${encodeURIComponent(entityName)}&includePrevious=false`,
      {
        headers: {
          'Accept': 'application/json',
          'Referer': `${IAPD_SITE}/`,
          'User-Agent': 'Mozilla/5.0 (compatible; CompetitorIntel/1.0)',
        },
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const hits: IAPDHit[] = data?.hits?.hits || [];

    // Find best match — prefer active IA firms matching the name
    const nameNorm = entityName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = hits.find(h => {
      const src = h._source;
      if (src.firm_ia_scope !== 'ACTIVE') return false;
      const names = [src.firm_name, ...(src.firm_other_names || [])];
      return names.some(n => {
        const norm = (n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return norm.includes(nameNorm) || nameNorm.includes(norm);
      });
    });
    // Only return the exact match — don't fall back to unrelated firms
    return match || null;
  } catch {
    return null;
  }
}

async function getIAPDDetail(crd: string): Promise<any | null> {
  try {
    const res = await fetch(`${IAPD_FIRM}/${crd}`, {
      headers: {
        'Accept': 'application/json',
        'Referer': `${IAPD_SITE}/firm/summary/${crd}`,
        'User-Agent': 'Mozilla/5.0 (compatible; CompetitorIntel/1.0)',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data?.hits?.hits?.[0];
    if (!hit?._source?.iacontent) return null;
    return JSON.parse(hit._source.iacontent);
  } catch {
    return null;
  }
}

function parseAddress(addrJson: string | undefined): string {
  if (!addrJson) return '';
  try {
    const parsed = JSON.parse(addrJson);
    const a = parsed?.officeAddress;
    if (!a) return '';
    const parts = [a.street1, a.street2, a.city, a.state, a.postalCode].filter(Boolean);
    return parts.join(', ');
  } catch {
    return '';
  }
}

export async function analyzeAdv(entityId?: string): Promise<number> {
  const allEntities = await getAllEntitiesWithCustom();
  const targets = entityId
    ? allEntities.filter(e => e.id === entityId)
    : allEntities;

  let analyzed = 0;

  for (let i = 0; i < targets.length; i++) {
    const entity = targets[i];
    try {
      const hit = await searchIAPD(entity.name);
      if (!hit) continue;

      const src = hit._source;
      const crd = src.firm_source_id;
      if (!crd) continue;

      // Get detailed firm data
      const detail = await getIAPDDetail(crd);

      const basic = detail?.basicInformation || {};
      const brochures = detail?.brochures?.brochuredetails || [];
      const noticeFilings = detail?.noticeFilings || [];
      const latestBrochure = brochures[0] || {};

      const analysis: FormAdvAnalysis = {
        entity_id: entity.id,
        entity_name: entity.name,
        crd,
        sec_number: basic.iaSECNumberType && basic.iaSECNumber
          ? `${basic.iaSECNumberType}-${basic.iaSECNumber}`
          : src.firm_ia_full_sec_number || '',
        registration_status: src.firm_ia_scope || basic.iaScope || 'Unknown',
        filing_date: basic.advFilingDate || '',
        firm_name: src.firm_name || basic.firmName || entity.name,
        other_names: (src.firm_other_names || basic.otherNames || []).filter(
          (n: string) => n.toUpperCase() !== (src.firm_name || '').toUpperCase(),
        ),
        office_address: parseAddress(src.firm_ia_address_details) ||
          (detail?.iaFirmAddressDetails?.officeAddress
            ? [
                detail.iaFirmAddressDetails.officeAddress.street1,
                detail.iaFirmAddressDetails.officeAddress.city,
                detail.iaFirmAddressDetails.officeAddress.state,
                detail.iaFirmAddressDetails.officeAddress.postalCode,
              ].filter(Boolean).join(', ')
            : ''),
        has_disclosures: src.firm_ia_disclosure_fl === 'Y',
        branches_count: src.firm_branches_count || 0,
        notice_states: noticeFilings
          .filter((nf: any) => nf.status === 'Notice Filed')
          .map((nf: any) => nf.jurisdiction),
        brochure_name: latestBrochure.brochureName || '',
        brochure_date: latestBrochure.dateSubmitted || '',
        brochure_id: latestBrochure.brochureVersionID || null,
        iapd_url: `${IAPD_SITE}/firm/summary/${crd}`,
        pdf_url: basic.hasPdf === 'Y'
          ? `${REPORTS_SITE}/reports/ADV/${crd}/PDF/${crd}.pdf`
          : '',
        updated_at: new Date().toISOString(),
      };

      await saveAdvAnalysis(analysis);
      analyzed++;
    } catch (err: any) {
      console.error(`[ADV] Error for ${entity.name}: ${err.message}`);
    }

    // Rate limit — be respectful to SEC API
    if (i + 1 < targets.length) await new Promise(r => setTimeout(r, 500));
  }

  try {
    await logCrawl({
      crawl_type: 'adv_analysis',
      entity_id: entityId || null,
      articles_found: analyzed,
      status: analyzed > 0 ? 'success' : 'completed',
      error_message: analyzed === 0 ? 'No entities matched in IAPD' : null,
      finished_at: new Date().toISOString(),
    });
  } catch (logErr) {
    console.warn('[ADV] Failed to log crawl:', logErr);
  }

  return analyzed;
}
