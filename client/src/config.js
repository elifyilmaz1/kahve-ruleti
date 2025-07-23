const isDevelopment = process.env.NODE_ENV !== 'production';

const config = {
  apiUrl: isDevelopment ? 'http://localhost:5000' : 'https://kahve-ruleti-api.onrender.com',
  socketUrl: isDevelopment ? 'http://localhost:5000' : 'https://kahve-ruleti-api.onrender.com'
};

export default config; 