export const state = {
    entries: [],
    allCategories: [
        { id: 'cat_sermon', name: '설교' },
        { id: 'cat_meditation', name: '묵상' },
        { id: 'cat_prayer', name: '기도' },
        { id: 'cat_thanks', name: '감사' }
    ],
    categoryOrder: ['cat_sermon', 'cat_meditation', 'cat_prayer', 'cat_thanks'],
    currentCategory: 'cat_sermon',
    categoryUpdatedAt: new Date(0).toISOString(),
    allFolders: [],
    folderOrder: [],
    rootOrder: [],
    currentFolder: null,
    currentSortBy: 'created',
    currentSortOrder: 'desc',
    categorySorts: {},
    currentViewMode: 'default',
    isLoading: true,
    isEditMode: false,
    editingId: null,
    editBaseModifiedAt: 0, // 편집 시작 시점의 글 수정시각 (다른 기기 충돌 감지 기준)
    currentFontFamily: 'Pretendard',
    currentFontSize: 16, // 기본값 16
    activeColorMode: 'foreColor',
    currentUser: null,
    contextTargetId: null,
    contextCatId: null,
    contextFolderId: null,
    longPressTimer: null,
    lastFocusedEdit: null,
    touchStartX: 0,
    touchEndX: 0,
    wheelDebounceTimer: null,
    autoSaveTimer: null,
    isSelectMode: false,
    selectedEntries: []
};

export function saveCategoriesToLocal() {
    const data = {
        categories: state.allCategories,
        order: state.categoryOrder,
        folders: state.allFolders,
        folderOrder: state.folderOrder,
        rootOrder: state.rootOrder,
        updatedAt: state.categoryUpdatedAt || new Date().toISOString()
    };
    localStorage.setItem('faithCatData', JSON.stringify(data));
}

export function migrateRootOrder() {
    const topFolders = state.allFolders.filter(f => !f.parentFolderId);
    const orphanTopics = state.allCategories.filter(c => !c.folderId);
    const validIds = new Set([...topFolders.map(f => f.id), ...orphanTopics.map(c => c.id)]);
    const existing = (state.rootOrder || []).filter(id => validIds.has(id));
    const existingSet = new Set(existing);
    const appended = [];
    state.folderOrder.forEach(id => { if (validIds.has(id) && !existingSet.has(id)) { appended.push(id); existingSet.add(id); } });
    topFolders.forEach(f => { if (!existingSet.has(f.id)) { appended.push(f.id); existingSet.add(f.id); } });
    state.categoryOrder.forEach(id => { if (validIds.has(id) && !existingSet.has(id)) { appended.push(id); existingSet.add(id); } });
    orphanTopics.forEach(c => { if (!existingSet.has(c.id)) { appended.push(c.id); existingSet.add(c.id); } });
    state.rootOrder = [...existing, ...appended];
}

export function isReadOnlyView() {
    return state.currentViewMode === 'readOnly' || state.currentViewMode === 'book';
}

export function saveCategorySortsToLocal() {
    localStorage.setItem('faithCategorySorts', JSON.stringify(state.categorySorts));
}

export function loadCategorySortsFromLocal() {
    const raw = localStorage.getItem('faithCategorySorts');
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') state.categorySorts = parsed;
    } catch (e) {
        console.error("카테고리 정렬 설정 로드 실패", e);
    }
}

export function getCategorySort(catId) {
    const saved = state.categorySorts[catId];
    if (saved && saved.sortBy && saved.sortOrder) return { sortBy: saved.sortBy, sortOrder: saved.sortOrder };
    return { sortBy: 'created', sortOrder: 'desc' };
}

export function setCategorySort(catId, sortBy, sortOrder) {
    state.categorySorts[catId] = { sortBy, sortOrder };
    saveCategorySortsToLocal();
}

export function loadCategoriesFromLocal() {
    const localData = localStorage.getItem('faithCatData');
    if (localData) {
        try {
            const parsed = JSON.parse(localData);
            // 손상된 데이터로 비배열이 들어오면 이후 렌더링 전체가 깨지므로 배열 여부까지 검증
            if (Array.isArray(parsed.categories) && Array.isArray(parsed.order)) {
                state.allCategories = parsed.categories;
                state.categoryOrder = parsed.order;
                state.allFolders = Array.isArray(parsed.folders) ? parsed.folders : [];
                state.folderOrder = Array.isArray(parsed.folderOrder) ? parsed.folderOrder : [];
                state.rootOrder = Array.isArray(parsed.rootOrder) ? parsed.rootOrder : [];
                state.categoryUpdatedAt = parsed.updatedAt || new Date(0).toISOString();
                migrateRootOrder();
                const exists = state.allCategories.find(c => c.id === state.currentCategory && !c.isDeleted);
                if (!exists) {
                    const firstAvailable = state.categoryOrder
                        .map(id => state.allCategories.find(c => c.id === id))
                        .find(c => c && !c.isDeleted)
                        || state.allCategories.find(c => !c.isDeleted);
                    if (firstAvailable) state.currentCategory = firstAvailable.id;
                }
            }
        } catch (e) {
            console.error("카테고리 로드 실패", e);
        }
    }
}
