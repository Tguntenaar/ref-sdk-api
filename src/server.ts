import express, { Request, Response } from 'express'; // Import express and its types
import { searchToken } from './utils/search-token';
import {
  EstimateSwapView,
  Transaction,
  WRAP_NEAR_CONTRACT_ID,
  estimateSwap,
  fetchAllPools,
  ftGetTokenMetadata,
  getExpectedOutputFromSwapTodos,
  getStablePools,
  instantSwap,
  nearDepositTransaction,
  nearWithdrawTransaction,
  percentLess,
  scientificNotationToString,
  separateRoutes,
} from '@ref-finance/ref-sdk';
import Big from 'big.js';

const app = express();
const port = 3000;

interface TokenParams {
  token: string;
}

app.use(express.json());

app.get('/tokenMetadata/:token', async (req: Request<TokenParams>, res: Response) => {
  const { token } = req.params;
    // Fetch token metadata
    try {
  const tokenMatch = (await searchToken(token))[0];
  console.log(tokenMatch);
  if (!tokenMatch) {
    return res.status(404).json({
      error: `Token ${token} not found`,
    });
  }
    // Return the metadata with an empty icon field
    return res.json(tokenMatch);
  } catch (error) {
    return res.status(500).json({
      error: 'An error occurred while fetching token metadata',
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
