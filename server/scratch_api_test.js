async function testApis() {
  const baseUrl = 'https://vhntxps4ap01.sap.nandanterry.com/zapi_tables';
  try {
    // Test BKPF for 1 day
    console.log('Fetching BKPF...');
    const bkpfRes = await fetch(`${baseUrl}/bkpf?sap-client=500&bkpf_from=20260401&bkpf_to=20260401`);
    if (!bkpfRes.ok) throw new Error(`HTTP error! status: ${bkpfRes.status}`);
    const data = await bkpfRes.json();
    console.log('BKPF Data Type:', typeof data);
    if (Array.isArray(data)) {
        console.log('BKPF Count:', data.length);
        console.log('BKPF Sample:', JSON.stringify(data.slice(0, 2), null, 2));
    } else {
        console.log('BKPF Data:', String(data).substring(0, 500));
    }
  } catch (err) {
    console.error('Error fetching API:', err.message);
  }
}

testApis();
