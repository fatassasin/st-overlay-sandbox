// Sandbox 楼层去重：只折叠同一轮内、同角色、正文完全相同的连续 AI 消息。

export function isDuplicateAssistantFloor(previous, current) {
    if (!previous || !current || previous.is_user || current.is_user || previous.is_system || current.is_system) return false;
    if (String(previous.name || '') !== String(current.name || '')) return false;
    const previousText = String(previous.mes || '').trim();
    const currentText = String(current.mes || '').trim();
    return previousText !== '' && previousText === currentText;
}

export function selfCheckFloorFilter() {
    const ai = { name: 'A', is_user: false, is_system: false, mes: 'same' };
    if (!isDuplicateAssistantFloor(ai, { ...ai })) throw new Error('same assistant floor was not deduplicated');
    if (isDuplicateAssistantFloor(ai, { ...ai, name: 'B' })) throw new Error('different speakers were deduplicated');
    if (isDuplicateAssistantFloor(ai, { ...ai, mes: 'different' })) throw new Error('different text was deduplicated');
    return true;
}