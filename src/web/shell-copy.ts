import type { NextAction, CustomerSafeCapabilitySummary } from "../domain/client-project-snapshot.js";
import type { DeliveryTimelineEntry } from "../domain/delivery-timeline.js";
import type { AdvisorResult } from "../domain/delivery-advisor.js";
import type { Locale } from "./locale.js";

/**
 * APP-I18N-001: the one centralized, typed catalog of fixed Client Portal
 * shell copy - every static UI string `shell-render.ts` renders resolves
 * through this catalog, never a scattered per-call conditional. Dynamic,
 * customer/backend-supplied text (a snapshot's raw status enum value, an
 * `UNAVAILABLE`/`ERROR` free-text `reason`, customer/project identifiers,
 * timestamps) is passed through as-is and is deliberately out of scope
 * here - it is domain data, not fixed shell copy, and translating it
 * would require inventing a generic runtime-content translation platform
 * this bounded floor does not attempt.
 */
export interface ShellCopy {
  readonly portalHeaderSuffix: string;
  readonly skipLink: string;
  readonly footerDisclaimer: string;
  readonly loading: { readonly title: string; readonly status: string; readonly body: string };
  readonly notStarted: { readonly title: string; readonly status: string; readonly body: string };
  readonly unavailable: { readonly title: string; readonly status: string };
  readonly unsupported: { readonly title: string; readonly status: string };
  readonly blockedPage: { readonly title: string; readonly status: string };
  readonly errorPage: { readonly title: string; readonly status: string; readonly body: string };
  readonly notFound: { readonly title: string; readonly status: string; readonly body: string };
  readonly unauthenticated: { readonly title: string; readonly status: string; readonly body: string };
  readonly forbidden: { readonly title: string; readonly status: string; readonly body: string };
  readonly ready: { readonly title: string; readonly status: string };
  readonly nextActionHeading: string;
  readonly nextAction: Record<NextAction["owner"], { readonly label: string; readonly badge: string }>;
  readonly timelineHeading: string;
  readonly noUpdatesYet: string;
  readonly timelineCategory: Record<DeliveryTimelineEntry["category"], string>;
  readonly blockerHeading: string;
  readonly blockedSince: (timestamp: string) => string;
  readonly blockerFallback: string;
  readonly workingArtifactHeading: string;
  readonly currentVersionLabel: (version: string) => string;
  readonly approved: string;
  readonly previewNotApproved: string;
  readonly newerVersionExists: (approvedVersion: string, currentVersion: string) => string;
  readonly capabilitiesHeading: string;
  readonly capabilityStatus: Record<CustomerSafeCapabilitySummary["status"], string>;
  readonly communicationsHeading: string;
  readonly evidenceLabel: string;
  readonly advisorHeading: string;
  readonly advisorUnavailableStatus: string;
  readonly advisorUnavailableBody: string;
  readonly advisorMaturity: Record<AdvisorResult["maturity"], string>;
  readonly advisorRecommendationIntro: string;
  readonly teamAttentionHeading: string;
  readonly teamUnavailableStatus: string;
  readonly teamUnavailableBody: string;
  readonly yourRole: (role: string) => string;
  readonly yourRoleNotEstablished: string;
  readonly ownerLabel: {
    readonly leadOwnerMembershipId: string;
    readonly dealOwnerMembershipId: string;
    readonly accountOwnerMembershipId: string;
    readonly deliveryOwnerMembershipId: string;
  };
  readonly notAssigned: string;
  readonly attentionLabel: (level: string, reason: string | undefined) => string;
  readonly attentionNoData: string;
  readonly commercialUnavailable: string;
  readonly verifiedWorkHeading: string;
  readonly verifiedWorkCount: (count: number) => string;
  readonly projectHeading: string;
  readonly customerLabel: (id: string) => string;
  readonly projectLabel: (id: string) => string;
  readonly overallStatusLabel: (status: string) => string;
}

const EN: ShellCopy = {
  portalHeaderSuffix: "Client Portal Shell",
  skipLink: "Skip to main content",
  footerDisclaimer: "This is an internal engineering checkpoint (V2-APP-001/V2-CDO-006), not a released customer product.",
  loading: { title: "Loading", status: "Loading — please wait", body: "This page is loading. It is not yet showing your project status." },
  notStarted: { title: "Not started", status: "Not started yet", body: "This project does not have any recorded work yet." },
  unavailable: { title: "Temporarily unavailable", status: "Temporarily unavailable" },
  unsupported: { title: "Not supported", status: "Not supported yet" },
  blockedPage: { title: "Blocked", status: "Blocked — attention needed" },
  errorPage: { title: "Something went wrong", status: "Something went wrong", body: "We could not load this page. No project data is shown." },
  notFound: { title: "Not found", status: "Not found", body: "We could not find this project." },
  unauthenticated: { title: "Sign-in required", status: "Sign-in required", body: "You must be signed in to view this page." },
  forbidden: { title: "Access denied", status: "Access denied", body: "You do not have access to this project." },
  ready: { title: "Project status", status: "Signed in" },
  nextActionHeading: "Next action",
  nextAction: {
    NO_ACTION_NEEDED: { label: "Nothing needed from you right now.", badge: "NO ACTION NEEDED" },
    CLIENT_ACTION_REQUIRED: { label: "Action is needed from you.", badge: "YOUR ACTION" },
    AKILTA_ACTION_REQUIRED: { label: "AKILTA is handling the next step.", badge: "AKILTA WORKING" },
    EXTERNAL_WAIT: { label: "Waiting on an external factor.", badge: "EXTERNAL WAIT" },
  },
  timelineHeading: "Timeline",
  noUpdatesYet: "No updates recorded yet.",
  timelineCategory: {
    STATUS_UPDATE: "Status update",
    BLOCKER: "Blocking issue",
    VERIFICATION: "Verified",
    ACTION_REQUIRED: "Action required",
    WORKING_ARTIFACT: "Working artifact update",
    APPROVAL: "Approval",
  },
  blockerHeading: "Blocked",
  blockedSince: (timestamp) => `Blocked since <time datetime="${timestamp}">${timestamp}</time>.`,
  blockerFallback: "A blocking issue was detected. No further customer-safe detail is available yet.",
  workingArtifactHeading: "Working artifact",
  currentVersionLabel: (version) => `Current version: ${version}`,
  approved: "Approved",
  previewNotApproved: "Preview — not yet approved",
  newerVersionExists: (approvedVersion, currentVersion) =>
    `A newer version exists since the last approval (version ${approvedVersion} was approved; current is version ${currentVersion}).`,
  capabilitiesHeading: "Connections & capabilities",
  capabilityStatus: {
    UNVERIFIED: "Not yet verified",
    VERIFIED_AVAILABLE: "Ready",
    UNSUPPORTED: "Not supported",
    INELIGIBLE: "Not eligible",
  },
  communicationsHeading: "Recent updates",
  evidenceLabel: "evidence",
  advisorHeading: "Delivery advisor",
  advisorUnavailableStatus: "Advisor unavailable",
  advisorUnavailableBody: "The delivery advisor could not be computed for this project. This does not affect your project status above.",
  advisorMaturity: {
    L0_OBSERVE: "ADVISOR: OBSERVE",
    L1_RECOMMEND: "ADVISOR: RECOMMEND",
  },
  advisorRecommendationIntro: "Advisor recommendation — not verified evidence, not an approval:",
  teamAttentionHeading: "Team & attention",
  teamUnavailableStatus: "Unavailable",
  teamUnavailableBody: "Team and attention context could not be loaded for this project. This does not affect your project status above.",
  yourRole: (role) => `Your role: ${role}`,
  yourRoleNotEstablished: "Your role: not established",
  ownerLabel: {
    leadOwnerMembershipId: "Lead Owner",
    dealOwnerMembershipId: "Deal Owner",
    accountOwnerMembershipId: "Account Owner",
    deliveryOwnerMembershipId: "Delivery Owner",
  },
  notAssigned: "not assigned",
  attentionLabel: (level, reason) => `Attention: ${level}${reason !== undefined ? ` — ${reason}` : ""}`,
  attentionNoData: "Attention: no data available",
  commercialUnavailable: "Commercial: Unavailable — pending separate commercial-authority checkpoint",
  verifiedWorkHeading: "Verified completed work",
  verifiedWorkCount: (count) => `${count} item(s) verified complete.`,
  projectHeading: "Project",
  customerLabel: (id) => `Customer: ${id}`,
  projectLabel: (id) => `Project: ${id}`,
  overallStatusLabel: (status) => `Overall status: <strong>${status}</strong>`,
};

const TR: ShellCopy = {
  portalHeaderSuffix: "Müşteri Portalı",
  skipLink: "Ana içeriğe geç",
  footerDisclaimer: "Bu, yayınlanmış bir müşteri ürünü değil, dahili bir mühendislik kontrol noktasıdır (V2-APP-001/V2-CDO-006).",
  loading: { title: "Yükleniyor", status: "Yükleniyor — lütfen bekleyin", body: "Bu sayfa yükleniyor. Proje durumunuz henüz gösterilmiyor." },
  notStarted: { title: "Başlamadı", status: "Henüz başlamadı", body: "Bu proje için henüz kayıtlı bir çalışma yok." },
  unavailable: { title: "Geçici olarak kullanılamıyor", status: "Geçici olarak kullanılamıyor" },
  unsupported: { title: "Desteklenmiyor", status: "Henüz desteklenmiyor" },
  blockedPage: { title: "Bekletiliyor", status: "Bekletiliyor — ilginiz gerekiyor" },
  errorPage: { title: "Bir şeyler yanlış gitti", status: "Bir şeyler yanlış gitti", body: "Bu sayfa yüklenemedi. Proje verisi gösterilmiyor." },
  notFound: { title: "Bulunamadı", status: "Bulunamadı", body: "Bu projeyi bulamadık." },
  unauthenticated: { title: "Giriş gerekli", status: "Giriş gerekli", body: "Bu sayfayı görüntülemek için giriş yapmalısınız." },
  forbidden: { title: "Erişim reddedildi", status: "Erişim reddedildi", body: "Bu projeye erişiminiz yok." },
  ready: { title: "Proje durumu", status: "Giriş yapıldı" },
  nextActionHeading: "Sıradaki adım",
  nextAction: {
    NO_ACTION_NEEDED: { label: "Şu anda sizden bir şey gerekmiyor.", badge: "İŞLEM GEREKMİYOR" },
    CLIENT_ACTION_REQUIRED: { label: "Sizden bir işlem yapmanız gerekiyor.", badge: "SİZİN İŞLEMİNİZ" },
    AKILTA_ACTION_REQUIRED: { label: "AKILTA sıradaki adımı yürütüyor.", badge: "AKILTA ÇALIŞIYOR" },
    EXTERNAL_WAIT: { label: "Harici bir etken bekleniyor.", badge: "HARİCİ BEKLEME" },
  },
  timelineHeading: "Zaman çizelgesi",
  noUpdatesYet: "Henüz kayıtlı bir güncelleme yok.",
  timelineCategory: {
    STATUS_UPDATE: "Durum güncellemesi",
    BLOCKER: "Engelleyici sorun",
    VERIFICATION: "Doğrulandı",
    ACTION_REQUIRED: "İşlem gerekiyor",
    WORKING_ARTIFACT: "Çalışma çıktısı güncellemesi",
    APPROVAL: "Onay",
  },
  blockerHeading: "Bekletiliyor",
  blockedSince: (timestamp) => `<time datetime="${timestamp}">${timestamp}</time> tarihinden beri bekletiliyor.`,
  blockerFallback: "Engelleyici bir sorun tespit edildi. Şu anda müşteriyle paylaşılabilecek başka bir ayrıntı yok.",
  workingArtifactHeading: "Çalışma çıktısı",
  currentVersionLabel: (version) => `Mevcut sürüm: ${version}`,
  approved: "Onaylandı",
  previewNotApproved: "Ön izleme — henüz onaylanmadı",
  newerVersionExists: (approvedVersion, currentVersion) =>
    `Son onaydan bu yana daha yeni bir sürüm var (onaylanan sürüm ${approvedVersion}; mevcut sürüm ${currentVersion}).`,
  capabilitiesHeading: "Bağlantılar ve yetkinlikler",
  capabilityStatus: {
    UNVERIFIED: "Henüz doğrulanmadı",
    VERIFIED_AVAILABLE: "Hazır",
    UNSUPPORTED: "Desteklenmiyor",
    INELIGIBLE: "Uygun değil",
  },
  communicationsHeading: "Son güncellemeler",
  evidenceLabel: "kanıt",
  advisorHeading: "Teslimat danışmanı",
  advisorUnavailableStatus: "Danışman kullanılamıyor",
  advisorUnavailableBody: "Bu proje için teslimat danışmanı hesaplanamadı. Bu durum yukarıdaki proje durumunuzu etkilemez.",
  advisorMaturity: {
    L0_OBSERVE: "DANIŞMAN: GÖZLEM",
    L1_RECOMMEND: "DANIŞMAN: ÖNERİ",
  },
  advisorRecommendationIntro: "Danışman önerisi — doğrulanmış kanıt veya onay değildir:",
  teamAttentionHeading: "Ekip ve ilgi durumu",
  teamUnavailableStatus: "Kullanılamıyor",
  teamUnavailableBody: "Bu proje için ekip ve ilgi durumu bilgisi yüklenemedi. Bu durum yukarıdaki proje durumunuzu etkilemez.",
  yourRole: (role) => `Rolünüz: ${role}`,
  yourRoleNotEstablished: "Rolünüz: belirlenmedi",
  ownerLabel: {
    leadOwnerMembershipId: "Talep Sahibi",
    dealOwnerMembershipId: "Anlaşma Sahibi",
    accountOwnerMembershipId: "Hesap Sahibi",
    deliveryOwnerMembershipId: "Teslimat Sahibi",
  },
  notAssigned: "atanmadı",
  attentionLabel: (level, reason) => `İlgi durumu: ${level}${reason !== undefined ? ` — ${reason}` : ""}`,
  attentionNoData: "İlgi durumu: veri yok",
  commercialUnavailable: "Ticari: Kullanılamıyor — ayrı bir ticari yetki kontrol noktası bekleniyor",
  verifiedWorkHeading: "Doğrulanmış tamamlanan çalışma",
  verifiedWorkCount: (count) => `${count} öğe doğrulanmış olarak tamamlandı.`,
  projectHeading: "Proje",
  customerLabel: (id) => `Müşteri: ${id}`,
  projectLabel: (id) => `Proje: ${id}`,
  overallStatusLabel: (status) => `Genel durum: <strong>${status}</strong>`,
};

const CATALOG: Readonly<Record<Locale, ShellCopy>> = { en: EN, tr: TR };

export function resolveShellCopy(locale: Locale): ShellCopy {
  return CATALOG[locale];
}
