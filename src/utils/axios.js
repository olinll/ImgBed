import axios from 'axios';

// 创建axios实例
const instance = axios.create({
  baseURL: '/',
  withCredentials: true, // 始终携带 Cookie（HttpOnly session cookie）
});

export default instance;
