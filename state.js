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
    currentFolder: null,
    currentSortBy: 'created',
    currentSortOrder: 'desc',
    categorySorts: {},
    currentViewMode: 'default',
    isLoading: true,
    isEditMode: false,
    editingId: null,
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
        updatedAt: state.categoryUpdatedAt || new Date().toISOString()
    };
    localStorage.setItem('faithCatData', JSON.stringify(data));
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
            if (parsed.categories && parsed.order) {
                state.allCategories = parsed.categories;
                state.categoryOrder = parsed.order;
                state.allFolders = parsed.folders || [];
                state.folderOrder = parsed.folderOrder || [];
                state.categoryUpdatedAt = parsed.updatedAt || new Date(0).toISOString();
                const exists = state.allCategories.find(c => c.id === state.currentCategory);
                if (!exists && state.categoryOrder.length > 0) {
                    state.currentCategory = state.categoryOrder[0];
                }
            }
        } catch (e) {
            console.error("카테고리 로드 실패", e);
        }
    }
}
