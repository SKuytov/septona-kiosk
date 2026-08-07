export type Role = 'admin' | 'editor' | 'viewer'
export type Language = 'bg' | 'en' | 'both'

export interface User { id: string; email: string; name: string; role: Role; createdAt?: string }
export interface Category { id: string; slug?: string; nameBg: string; nameEn: string; icon: IconName; colour: string; sortOrder: number; cycleSeconds: number | null; visible: boolean; parentId: string | null }
export type IconName = 'exit' | 'policy' | 'pin' | 'book' | 'shield' | 'fire' | 'doc' | 'people' | 'leaf' | 'factory' | 'phone' | 'clipboard'
export interface Version { id: string; versionNumber?: number; createdAt?: string; uploadedAt?: string; uploaderName?: string; uploader?: User; note?: string | null; sizeBytes?: number; sourceFile?: string }
export interface Document { id: string; categoryId: string; titleBg: string; titleEn: string; language: Language; tags: string[]; sortOrder: number; pinned: boolean; versionId: string; versionNumber: number; sha256?: string; sizeBytes: number; pageCount?: number; updatedAt: string; fileUrl?: string; versions?: Version[] }
export interface AuditEntry { id: number | string; at: string; actorType: 'user' | 'device' | 'system'; actorId?: string; actorName?: string; action: string; entity: string; entityId: string; summary: string; before: unknown; after: unknown; ip?: string }
export interface Device { id: string; name?: string; label?: string; createdAt?: string; lastSeenAt?: string | null; appVersion?: string; manifestVersion?: number; docsCached?: number; storageBytes?: number; revokedAt?: string | null; key?: string }
export interface Settings { cycleEnabled: boolean; cycleSeconds: number; idleResumeSeconds: number; defaultLanguage: 'bg' | 'en'; kioskTitle: string; syncIntervalMinutes: number; allowOfficeConversion?: boolean }
export interface Stats { categories?: number; documents?: number; devices?: number; users?: number; [key: string]: number | undefined }
export interface Paged<T> { items?: T[]; data?: T[]; total?: number; page?: number; pageSize?: number }
export interface ApiError { status: number; code?: string; message: string; payload?: unknown }
