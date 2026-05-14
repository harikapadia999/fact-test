import http from 'http';

http.get('http://localhost:3000/api/nodes', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log('RESPONSE:', data));
}).on('error', (err) => console.error('ERROR:', err.message));
