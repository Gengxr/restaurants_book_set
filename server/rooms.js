export const SLOTS = {
  NOON: 'noon',
  EVENING: 'evening'
};

export const ROOMS = [
  { id: 1, name: '步步高升', recommended: 8 },
  { id: 2, name: '丰衣足食', recommended: 8 },
  { id: 3, name: '金玉满堂', recommended: 12 },
  { id: 4, name: '春种秋收', recommended: 8 },
  { id: 5, name: '五福临门', recommended: 10 },
  { id: 6, name: '年年有鱼', recommended: 10 },
  { id: 7, name: '大吉大利', recommended: 4 },
  { id: 8, name: '田园风光', recommended: 10 },
  { id: 9, name: '风调雨顺', recommended: 10 },
  { id: 10, name: '五谷丰登', recommended: 8 },
  { id: 11, name: '乡里乡亲', recommended: 6 },
  { id: 12, name: '左邻右舍', recommended: 6 },
  { id: 13, name: '走亲访友', recommended: 6 },
  { id: 14, name: '长桌1', recommended: 4 },
  { id: 15, name: '长桌2', recommended: 4 },
  { id: 16, name: '长桌3', recommended: 4 },
  { id: 17, name: '地桌5', recommended: 10 },
  { id: 18, name: '地桌6', recommended: 10 }
];

export function isKnownRoom(roomId) {
  return ROOMS.some((room) => room.id === Number(roomId));
}
