import { randomUUID } from 'node:crypto';
import { DEFAULT_PROMPT_TEMPLATES } from './index.js';
import type { ActivePrompt, PromptKey, PromptTemplate } from './templates.js';
import type { PromptAuditRecord, PromptRepository, PromptTemplateRecord, PromptVersion } from './repository.js';

export class MemoryPromptRepository implements PromptRepository {
  private readonly templates = new Map<PromptKey, PromptTemplateRecord>();
  private readonly versions = new Map<PromptKey, PromptVersion[]>();
  private readonly audit: PromptAuditRecord[] = [];
  constructor() {
    for (const key of ['RECOMMEND', 'FLASHCARD'] as const) {
      const now = new Date().toISOString(); const templateId = randomUUID(); const versionId = randomUUID();
      this.templates.set(key, { id: templateId, prompt_key: key, name: key === 'RECOMMEND' ? '학습 주제 추천' : '플래시카드 생성',
        description: '', is_enabled: true, created_at: now });
      this.versions.set(key, [{ id: versionId, template_id: templateId, version_number: 1, ...DEFAULT_PROMPT_TEMPLATES[key],
        status: 'ACTIVE', change_note: '기본 코드 프롬프트', created_by: null, created_at: now, activated_by: 'system', activated_at: now }]);
    }
  }
  async loadActivePrompt(key: PromptKey): Promise<ActivePrompt | null> {
    const version = this.versions.get(key)?.find(row => row.status === 'ACTIVE');
    return version ? { id: version.id, version_number: version.version_number, system_prompt: version.system_prompt,
      developer_prompt: version.developer_prompt, user_template: version.user_template } : null;
  }
  async listPromptTemplates(): Promise<PromptTemplateRecord[]> {
    return [...this.templates.values()].map(template => ({ ...template, versions: [...(this.versions.get(template.prompt_key) ?? [])]
      .sort((a, b) => b.version_number - a.version_number) }));
  }
  async listPromptVersions(key: PromptKey): Promise<PromptVersion[]> { return [...(this.versions.get(key) ?? [])].sort((a, b) => b.version_number - a.version_number); }
  async getPromptVersion(key: PromptKey, id: string): Promise<PromptVersion | null> { return this.versions.get(key)?.find(version => version.id === id) ?? null; }
  async createPromptDraft(key: PromptKey, actorId: string, note: string): Promise<PromptVersion> {
    const active = this.versions.get(key)?.find(version => version.status === 'ACTIVE');
    if (!active) throw new Error('active prompt version is missing');
    const version = this.makeVersion(key, active, actorId, note);
    this.record(key, version, 'DRAFT_CREATED', actorId, note || '운영 버전에서 초안 생성'); return version;
  }
  async updatePromptDraft(key: PromptKey, id: string, actorId: string, value: PromptTemplate, note: string): Promise<PromptVersion> {
    const versions = this.versions.get(key) ?? []; const version = versions.find(row => row.id === id && row.status === 'DRAFT');
    if (!version) throw Object.assign(new Error('draft not found or immutable'), { status: 404 });
    Object.assign(version, value, { change_note: note }); this.record(key, version, 'DRAFT_UPDATED', actorId, note || '초안 수정'); return version;
  }
  async activatePromptVersion(key: PromptKey, id: string, actorId: string, expectedActiveVersionId: string): Promise<PromptVersion> {
    const versions = this.versions.get(key) ?? []; const active = versions.find(row => row.status === 'ACTIVE');
    if (active?.id !== expectedActiveVersionId) throw Object.assign(new Error('active prompt version conflict'), { code: '40001' });
    const draft = versions.find(row => row.id === id && row.status === 'DRAFT');
    if (!draft) throw Object.assign(new Error('draft version not found'), { status: 404 });
    Object.assign(active!, { status: 'ARCHIVED' });
    Object.assign(draft, { status: 'ACTIVE', activated_by: actorId, activated_at: new Date().toISOString() });
    this.record(key, draft, 'ACTIVATED', actorId, '운영 프롬프트 적용'); return draft;
  }
  async restorePromptVersion(key: PromptKey, sourceId: string, actorId: string, note: string): Promise<PromptVersion> {
    const source = await this.getPromptVersion(key, sourceId); if (!source) throw Object.assign(new Error('source prompt version not found'), { status: 404 });
    const version = this.makeVersion(key, source, actorId, note || `v${source.version_number}에서 복원`);
    this.record(key, version, 'RESTORED', actorId, `v${source.version_number} 내용을 새 초안 v${version.version_number}로 복사`); return version;
  }
  async listPromptAudit(key: PromptKey, limit: number): Promise<PromptAuditRecord[]> {
    const templateId = this.templates.get(key)!.id;
    return this.audit.filter(item => item.template_id === templateId).slice(-limit).reverse();
  }
  private makeVersion(key: PromptKey, source: PromptTemplate, actorId: string, note: string): PromptVersion {
    const versions = this.versions.get(key) ?? []; const templateId = this.templates.get(key)!.id; const now = new Date().toISOString();
    const version: PromptVersion = { id: randomUUID(), template_id: templateId,
      version_number: Math.max(0, ...versions.map(row => row.version_number)) + 1,
      system_prompt: source.system_prompt, developer_prompt: source.developer_prompt, user_template: source.user_template,
      status: 'DRAFT', change_note: note, created_by: actorId, created_at: now, activated_by: null, activated_at: null };
    versions.push(version); this.versions.set(key, versions); return version;
  }
  private record(key: PromptKey, version: PromptVersion, action: PromptAuditRecord['action'], actor: string, summary: string) {
    this.audit.push({ id: randomUUID(), template_id: this.templates.get(key)!.id, version_id: version.id,
      action, actor_user_id: actor, change_summary: summary, created_at: new Date().toISOString() });
  }
}
