const { assert, expect } = require('chai')
const chai = require('chai')
const { solidity } = require('ethereum-waffle')
chai.use(solidity)
const utils = require('./lib/utils')
const setup = require('./lib/setup')
const constants = require('./lib/constants')
const { parseEther, formatEther } = require('ethers/lib/utils')
const { assertBNEqual } = utils
const { ONE_ETHER, MILLION_ETHER } = constants.VALUES
const UniswapV2Pair = require('@uniswap/v2-core/build/UniswapV2Pair.json')
const batchApproval = require('./lib/batchApproval')
const { sortTokens } = require('./lib/utils')
const { BigNumber } = require('ethers')

const _addLiquidity = async (router, reserves, amountADesired, amountBDesired, amountAMin, amountBMin) => {
  let amountA, amountB
  let amountBOptimal = await router.quote(amountADesired, reserves[0], reserves[1])
  if (amountBOptimal <= amountBDesired) {
    assert.equal(amountBOptimal >= amountBMin, true, `${formatEther(amountBOptimal)} !>= ${formatEther(amountBMin)}`)
    ;[amountA, amountB] = [amountADesired, amountBOptimal]
  } else {
    let amountAOptimal = await router.quote(amountBDesired, reserves[1], reserves[0])

    assert.equal(amountAOptimal >= amountAMin, true, `${formatEther(amountAOptimal)} !>= ${formatEther(amountAMin)}`)
    ;[amountA, amountB] = [amountAOptimal, amountBDesired]
  }

  return [amountA, amountB]
}

const getReserves = async (signer, factory, tokenA, tokenB) => {
  let tokens = sortTokens(tokenA, tokenB)
  let token0 = tokens[0]
  let pair = new ethers.Contract(await factory.getPair(tokenA, tokenB), UniswapV2Pair.abi, signer)
  let [_reserve0, _reserve1] = await pair.getReserves()

  let reserves = tokenA == token0 ? [_reserve0, _reserve1] : [_reserve1, _reserve0]
  return reserves
}

const getAmountsOutPure = (amountIn, path, reserveIn, reserveOut) => {
  let amounts = [amountIn]
  for (let i = 0; i < path.length; i++) {
    amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut)
  }

  return amounts
}

const getAmountOut = (amountIn, reserveIn, reserveOut) => {
  let amountInWithFee = amountIn.mul(997)
  let numerator = amountInWithFee.mul(reserveOut)
  let denominator = reserveIn.mul(1000).add(amountInWithFee)
  let amountOut = numerator.div(denominator)
  return amountOut
}

const getAmountsInPure = (amountOut, path, reserveIn, reserveOut) => {
  let amounts = ['', amountOut]
  for (let i = path.length - 1; i > 0; i--) {
    amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut)
  }

  return amounts
}

const getAmountIn = (amountOut, reserveIn, reserveOut) => {
  let numerator = reserveIn.mul(amountOut).mul(1000)
  let denominator = reserveOut.sub(amountOut).mul(997)
  let amountIn = numerator.div(denominator).add(1)
  return amountIn
}

const getPremium = (quantityOptions, base, quote, redeemToken, underlyingToken, reserveIn, reserveOut) => {
  // PREMIUM MATH
  let redeemsMinted = quantityOptions.mul(quote).div(base)
  let path = [redeemToken.address, underlyingToken.address]
  let amountsIn = getAmountsInPure(quantityOptions, path, reserveIn, reserveOut)
  let redeemsRequired = amountsIn[0]
  let redeemCostRemaining = redeemsRequired.sub(redeemsMinted)
  // if redeemCost > 0
  let amountsOut = getAmountsOutPure(redeemCostRemaining, path, reserveIn, reserveOut)
  //let loanRemainder = amountsOut[1].mul(101101).add(amountsOut[1]).div(100000)
  let loanRemainder = amountsOut[1].mul(100000).add(amountsOut[1].mul(301)).div(100000)

  let premium = loanRemainder

  return premium
}

describe('UniswapConnector', () => {
  // ACCOUNTS
  let Admin, User, Alice

  let trader, weth, dai, optionToken, redeemToken, quoteToken
  let underlyingToken, strikeToken
  let base, quote, expiry
  let Primitive, registry
  let uniswapFactory, uniswapRouter, uniswapConnector
  let premium
  // regular deadline
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20

  assertInvariant = async () => {
    assertBNEqual(await optionToken.balanceOf(uniswapConnector.address), '0')
    assertBNEqual(await redeemToken.balanceOf(uniswapConnector.address), '0')
    assertBNEqual(await weth.balanceOf(uniswapConnector.address), '0')
    assertBNEqual(await dai.balanceOf(uniswapConnector.address), '0')
  }

  afterEach(async () => {
    await assertInvariant()
  })

  before(async () => {
    let signers = await setup.newWallets()

    // Signers
    Admin = signers[0]
    User = signers[1]

    // Addresses of Signers
    Alice = Admin.address
    Bob = User.address

    // Underlying and quote token instances
    //weth = await setup.newWeth(Admin)
    weth = await setup.newERC20(Admin, 'TEST WETH', 'WETH', MILLION_ETHER)
    dai = await setup.newERC20(Admin, 'TEST DAI', 'DAI', MILLION_ETHER)
    quoteToken = dai

    // Administrative contract instances
    registry = await setup.newRegistry(Admin)
    // Uniswap V2
    const uniswap = await setup.newUniswap(Admin, Alice, weth)
    uniswapFactory = uniswap.uniswapFactory
    uniswapRouter = uniswap.uniswapRouter
    await uniswapFactory.setFeeTo(Alice)

    // Option parameters
    underlyingToken = weth
    strikeToken = dai
    base = parseEther('1')
    quote = parseEther('3')
    expiry = '1690868800' // May 30, 2020, 8PM UTC

    // Option and redeem instances
    Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
    optionToken = Primitive.optionToken
    redeemToken = Primitive.redeemToken

    // Trader Instance
    trader = await setup.newTrader(Admin, weth.address)

    // Uniswap Connector contract
    uniswapConnector = await setup.newUniswapConnector(Admin, [
      uniswapRouter.address,
      uniswapFactory.address,
      trader.address,
    ])

    // Approve all tokens and contracts
    await batchApproval(
      [trader.address, uniswapConnector.address, uniswapRouter.address],
      [underlyingToken, strikeToken, optionToken, redeemToken],
      [Admin]
    )

    // Create UNISWAP PAIRS
    // option <> dai: 1:10 ($10 option) 1,000 options and 10,000 dai (1,000 weth)
    // weth <> dai: 1:100 ($100 weth) 1,000 weth and 100,000 dai
    // redeem <> dai: 1:1 ($1 redeem) 100,000 redeems and 100,000 dai
    // redeem <> weth: 100:1 ($1 redeem) 100,000 redeems and 1,000 weth

    const totalOptions = parseEther('20')
    const totalDai = parseEther('2100')
    const totalRedeemForPair = totalOptions.mul(quote).div(base)
    premium = 10

    // MINT 2,010 WETH
    //await weth.deposit({ from: Alice, value: parseEther('50') })

    // MINT 1,000 OPTIONS
    await trader.safeMint(optionToken.address, totalOptions, Alice)

    // Mint some options for tests
    await trader.safeMint(optionToken.address, parseEther('0.1'), Alice)

    // MINT 210,000 DAI
    await dai.mint(Alice, totalDai)

    // Add liquidity to redeem <> weth pair
    await uniswapRouter.addLiquidity(
      redeemToken.address,
      weth.address,
      totalRedeemForPair,
      totalRedeemForPair.mul(base).div(quote),
      0,
      0,
      Alice,
      deadline
    )
  })

  describe('public variables', () => {
    it('router()', async () => {
      assert.equal(await uniswapConnector.router(), uniswapRouter.address)
    })
    it('factory()', async () => {
      assert.equal(await uniswapConnector.factory(), uniswapFactory.address)
    })
    it('trader()', async () => {
      assert.equal(await uniswapConnector.trader(), trader.address)
    })
    it('getName()', async () => {
      assert.equal(await uniswapConnector.getName(), 'PrimitiveV1UniswapConnector03')
    })
    it('getVersion()', async () => {
      assert.equal(await uniswapConnector.getVersion(), 3)
    })
  })

  describe('deployUniswapMarket', () => {
    it('deployUniswapMarket()', async () => {
      await uniswapConnector.deployUniswapMarket(optionToken.address, weth.address)
    })
  })

  describe('uniswapV2Call', () => {
    it('uniswapV2Call()', async () => {
      await expect(uniswapConnector.uniswapV2Call(Alice, '0', '0', ['1'])).to.be.reverted
    })
  })

  describe('mintShortOptionsThenSwapToTokens()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, uniswapConnector.address, uniswapRouter.address],
        [optionToken, redeemToken],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
      const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
      await trader.safeMint(optionToken.address, totalOptions.add(parseEther('10')), Alice)

      // Add liquidity to redeem <> weth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        weth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )
    })

    it('should mint Primitive V1 Options then swap shortTokens on Uniswap V2', async () => {
      // Get the pair address.
      let pair = await uniswapFactory.getPair(optionToken.address, dai.address)

      // Get the affected balances before the operation.
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(pair)
      let optionTokenAddress = optionToken.address
      let optionsToMint = parseEther('0.1')
      let amountIn = optionsToMint.mul(quote).div(base)
      let path = [redeemToken.address, underlyingToken.address] // path[0] MUST be the optionToken address.
      let amounts = await uniswapRouter.getAmountsOut(amountIn, path)
      let amountOutMin = amounts[path.length - 1]
      let to = Alice
      let deadline = Math.floor(Date.now() / 1000) + 60 * 20

      // Call the function
      // transfersFrom underlyingToken `optionsToMint` amount to mint options. Then swaps in unsiwap pair
      // for underlying tokens.
      // change = (-optionsToMint + amoutOutMin)
      await uniswapConnector.mintShortOptionsThenSwapToTokens(
        optionTokenAddress,
        optionsToMint,
        amountOutMin,
        path,
        to,
        deadline
      )

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(pair)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore).toString()
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore).toString()

      assertBNEqual(redeemChange, '0')
      assert.equal(
        underlyingChange >= amountOutMin.add(optionsToMint.mul(-1)),
        true,
        `underlyingDelta ${formatEther(underlyingChange)} != amountOutMin ${formatEther(amountOutMin)}`
      )
      assertBNEqual(await optionToken.balanceOf(uniswapConnector.address), '0')
    })

    it('should revert if quantity is zero', async () => {
      let optionTokenAddress = optionToken.address
      let optionsToMint = parseEther('0')
      let path = [redeemToken.address, underlyingToken.address] // path[0] MUST be the optionToken address.
      let amountOutMin = parseEther('0')
      let to = Alice
      let deadline = Math.floor(Date.now() / 1000) + 60 * 20

      // Call the function
      await expect(
        uniswapConnector.mintShortOptionsThenSwapToTokens(
          optionTokenAddress,
          optionsToMint,
          amountOutMin,
          path,
          to,
          deadline
        )
      ).to.be.revertedWith('ERR_ZERO')
    })

    it('should revert if we are not swapping from the redeem token', async () => {
      let optionTokenAddress = optionToken.address
      let optionsToMint = parseEther('0.1')
      let path = [optionToken.address, underlyingToken.address] // path[0] MUST be the redeemToken address.
      let amountOutMin = '1'
      let to = Alice
      let deadline = Math.floor(Date.now() / 1000) + 60 * 20

      // Call the function
      await expect(
        uniswapConnector.mintShortOptionsThenSwapToTokens(
          optionTokenAddress,
          optionsToMint,
          amountOutMin,
          path,
          to,
          deadline
        )
      ).to.be.revertedWith('ERR_PATH_OPTION_START')
    })
  })

  describe('mintOptionsThenFlashCloseLong()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, uniswapConnector.address, uniswapRouter.address],
        [optionToken, redeemToken],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
      const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
      await trader.safeMint(optionToken.address, totalOptions.add(parseEther('10')), Alice)

      // Add liquidity to redeem <> weth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        weth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )
    })

    it('should mint Primitive V1 Options then flashCloseLong the long option tokens', async () => {
      // Get the affected balances before the operation.
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionTokenAddress = optionToken.address
      let optionsToMint = parseEther('0.1')
      let amountIn = optionsToMint.mul(quote).div(base)
      let minPayout = await uniswapConnector.getClosePremium(optionTokenAddress, amountIn)

      // Call the function
      // transfersFrom underlyingToken `optionsToMint` amount to mint options. Then swaps in unsiwap pair
      // for underlying tokens.
      // change = (-optionsToMint + amoutOutMin)
      await expect(uniswapConnector.mintOptionsThenFlashCloseLong(optionTokenAddress, optionsToMint, minPayout[0]))
        .to.emit(uniswapConnector, 'WroteOption')
        .withArgs(Alice, optionsToMint)

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(Alice)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore).toString()
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore).toString()

      assertBNEqual(redeemChange, amountIn)
      assert.equal(
        underlyingChange >= minPayout[0].add(optionsToMint.mul(-1)),
        true,
        `underlyingDelta ${formatEther(underlyingChange)} != minPayout ${formatEther(minPayout[0])}`
      )
      assertBNEqual(await optionToken.balanceOf(uniswapConnector.address), '0')
    })

    it('should revert if quantity is zero', async () => {
      let optionTokenAddress = optionToken.address
      let optionsToMint = parseEther('0')
      let amountOutMin = parseEther('0')

      // Call the function
      await expect(
        uniswapConnector.mintOptionsThenFlashCloseLong(optionTokenAddress, optionsToMint, amountOutMin)
      ).to.be.revertedWith('ERR_ZERO')
    })

    it('should revert if quantity is minPayout is not zero and theres a negative premium', async () => {
      let optionTokenAddress = optionToken.address
      let optionsToMint = parseEther('1')
      let minPayout = '1'

      await expect(uniswapConnector.mintOptionsThenFlashCloseLong(optionTokenAddress, optionsToMint, minPayout)).to.be
        .reverted
    })
  })

  describe('addShortLiquidityWithUnderlying()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, uniswapConnector.address, uniswapRouter.address],
        [optionToken, redeemToken],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
      const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
      await trader.safeMint(optionToken.address, totalOptions.add(parseEther('10')), Alice)

      // Add liquidity to redeem <> weth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        weth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )
    })

    it('use underlyings to mint options, then provide short options and underlying tokens as liquidity', async () => {
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      let optionAddress = optionToken.address
      let amountOptions = parseEther('0.1')
      let amountADesired = amountOptions.mul(quote).div(base) // amount of options to mint 1:100
      let amountBMin = 0
      let to = Alice

      let path = [redeemToken.address, underlyingToken.address]

      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountBOptimal = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountAOptimal = await uniswapRouter.quote(amountBDesired, reserves[1], reserves[0])

      ;[, amountBMin] = await _addLiquidity(
        uniswapRouter,
        reserves,
        amountADesired,
        amountBDesired,
        amountAOptimal,
        amountBOptimal
      )

      await uniswapConnector.addShortLiquidityWithUnderlying(
        optionAddress,
        amountOptions,
        amountBDesired,
        amountBMin,
        to,
        deadline
      )

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(Alice)
      let optionBalanceAfter = await optionToken.balanceOf(Alice)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore)
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let optionChange = optionBalanceAfter.sub(optionBalanceBefore)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore)

      const expectedUnderlyingChange = amountOptions.mul(quote).div(base).mul(reserveB).div(reserveA).add(amountOptions)

      assertBNEqual(optionChange.toString(), amountOptions) // kept options
      assertBNEqual(redeemChange.toString(), '0') // kept options
      assertBNEqual(underlyingChange, expectedUnderlyingChange.mul(-1))
    })

    it('should revert if amountBMin is greater than optimal amountB', async () => {
      // assume the pair has a ratio of redeem : weth of 100 : 1.
      // If we attempt to provide 100 short tokens, we need to imply a price ratio when we call the function.
      // If we imply a ratio that is less than 100 : 1, it should revert.

      let optionAddress = optionToken.address
      let amountOptions = parseEther('0.1')
      // skew the amountADesired ratio to be more, so the transaction reverts
      let amountADesired = amountOptions.mul(quote).div(base) // amount of options to mint 1:100
      let amountBMin = 0
      let to = Alice

      let path = [redeemToken.address, underlyingToken.address]

      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountBOptimal = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountAOptimal = await uniswapRouter.quote(amountBDesired, reserves[1], reserves[0])

      ;[, amountBMin] = await _addLiquidity(
        uniswapRouter,
        reserves,
        amountADesired,
        amountBDesired,
        amountAOptimal,
        amountBOptimal
      )

      await expect(
        uniswapConnector.addShortLiquidityWithUnderlying(
          optionAddress,
          amountOptions,
          amountBDesired.add(1),
          amountBMin.add(1),
          to,
          deadline
        )
      ).to.be.revertedWith('UniswapV2Router: INSUFFICIENT_B_AMOUNT')
    })

    it('should revert if amountAMin is less than amountAOptimal', async () => {
      // assume the pair has a ratio of redeem : weth of 100 : 1.
      // If we attempt to provide 100 short tokens, we need to imply a ratio.
      // If we imply a ratio that is less than 100 : 1, it should revert.

      let optionAddress = optionToken.address
      let amountOptions = parseEther('0.1')
      let amountADesired = amountOptions.mul(quote).div(base) // amount of options to mint 1:100
      let amountBMin = 0
      let to = Alice

      let path = [redeemToken.address, underlyingToken.address]

      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountBOptimal = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountAOptimal = await uniswapRouter.quote(amountBDesired, reserves[1], reserves[0])

      ;[, amountBMin] = await _addLiquidity(
        uniswapRouter,
        reserves,
        amountADesired,
        amountBDesired,
        amountAOptimal,
        amountBOptimal
      )

      await expect(
        uniswapConnector.addShortLiquidityWithUnderlying(
          optionAddress,
          amountOptions,
          amountBDesired.sub(1),
          amountBMin,
          to,
          deadline
        )
      ).to.be.revertedWith('UniswapV2Router: INSUFFICIENT_A_AMOUNT')
    })
  })

  describe('removeShortLiquidityThenCloseOptions()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, uniswapConnector.address, uniswapRouter.address],
        [optionToken, redeemToken],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
      const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
      await trader.safeMint(optionToken.address, totalOptions.add(parseEther('10')), Alice)

      // Add liquidity to redeem <> weth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        weth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )
    })

    it('burns UNI-V2 lp shares, then closes the withdrawn shortTokens', async () => {
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let quoteBalanceBefore = await quoteToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      let optionAddress = optionToken.address
      let liquidity = parseEther('0.1')
      let path = [redeemToken.address, weth.address]
      let pairAddress = await uniswapConnector.getUniswapMarketForTokens(path[0], path[1])
      let pair = new ethers.Contract(pairAddress, UniswapV2Pair.abi, Admin)
      await pair.connect(Admin).approve(uniswapConnector.address, MILLION_ETHER)
      assert.equal((await pair.balanceOf(Alice)) >= liquidity, true, 'err not enough pair tokens')
      assert.equal(pairAddress != constants.ADDRESSES.ZERO_ADDRESS, true, 'err pair not deployed')

      let totalSupply = await pair.totalSupply()
      let amount0 = liquidity.mul(await redeemToken.balanceOf(pairAddress)).div(totalSupply)
      let amount1 = liquidity.mul(await weth.balanceOf(pairAddress)).div(totalSupply)

      let amountAMin = amount0
      let amountBMin = amount1
      let to = Alice

      await uniswapConnector.removeShortLiquidityThenCloseOptions(
        optionAddress,
        liquidity,
        amountAMin,
        amountBMin,
        to,
        deadline
      )

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let quoteBalanceAfter = await quoteToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(Alice)
      let optionBalanceAfter = await optionToken.balanceOf(Alice)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore)
      // Purchased quoteTokens with our options (Alice)
      let quoteChange = quoteBalanceAfter.sub(quoteBalanceBefore)
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let optionChange = optionBalanceAfter.sub(optionBalanceBefore)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore)

      assertBNEqual(underlyingChange.toString(), amountAMin.mul(base).div(quote).add(amountBMin))
      assertBNEqual(optionChange.toString(), amountAMin.mul(base).div(quote).mul(-1))
      assertBNEqual(quoteChange.toString(), '0')
      assert(redeemChange.gt(0) || redeemChange.isZero(), true, `Redeem change is not gt 0`)
    })
  })

  describe('openFlashLong()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, uniswapConnector.address, uniswapRouter.address],
        [optionToken, redeemToken],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
      /* const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000) */
      const totalOptions = '75716450507480110972130'
      const totalRedeemForPair = '286685334476675940449501'
      await trader.safeMint(optionToken.address, totalOptions, Alice)
      await trader.safeMint(optionToken.address, parseEther('100000'), Alice)

      // Add liquidity to redeem <> weth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        weth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )
    })

    it('gets a flash loan for underlyings, mints options, swaps redeem to underlyings to pay back', async () => {
      // Create a Uniswap V2 Pair and add liquidity.

      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let quoteBalanceBefore = await quoteToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      // Get the pair instance to approve it to the uniswapConnector
      let amountOptions = parseEther('0.1')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let premium = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])
      premium = premium.gt(0) ? premium : parseEther('0')

      await expect(uniswapConnector.openFlashLong(optionToken.address, amountOptions, premium))
        .to.emit(uniswapConnector, 'FlashOpened')
        .withArgs(uniswapConnector.address, amountOptions, premium)

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let quoteBalanceAfter = await quoteToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(Alice)
      let optionBalanceAfter = await optionToken.balanceOf(Alice)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore)
      // Purchased quoteTokens with our options (Alice)
      let quoteChange = quoteBalanceAfter.sub(quoteBalanceBefore)
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let optionChange = optionBalanceAfter.sub(optionBalanceBefore)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore)

      assert.equal(
        underlyingChange.toString() <= amountOptions.mul(-1).add(premium),
        true,
        `${formatEther(underlyingChange)} ${formatEther(amountOptions)}`
      )
      assertBNEqual(optionChange.toString(), amountOptions)
      assertBNEqual(quoteChange.toString(), '0')
      assertBNEqual(redeemChange.toString(), '0')
    })

    it('should revert if actual premium is above max premium', async () => {
      // Get the pair instance to approve it to the uniswapConnector
      let amountOptions = parseEther('0.1')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let maxPremium = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])
      maxPremium = maxPremium.gt(0) ? maxPremium : parseEther('0')
      await expect(uniswapConnector.openFlashLong(optionToken.address, amountOptions, maxPremium.sub(1))).to.be.revertedWith(
        'ERR_UNISWAPV2_CALL_FAIL'
      )
    })

    it('should do a normal flash close', async () => {
      // Get the pair instance to approve it to the uniswapConnector
      let amountRedeems = parseEther('0.1')
      await expect(uniswapConnector.closeFlashLong(optionToken.address, amountRedeems, '1')).to.emit(
        uniswapConnector,
        'FlashClosed'
      )
    })

    it('should revert with premium over max', async () => {
      // Get the pair instance to approve it to the uniswapConnector
      let amountRedeems = parseEther('0.1')
      await expect(uniswapConnector.closeFlashLong(optionToken.address, amountRedeems, amountRedeems)).to.be.revertedWith(
        'ERR_UNISWAPV2_CALL_FAIL'
      )
    })

    it('should revert flash loan quantity is zero', async () => {
      // Get the pair instance to approve it to the uniswapConnector
      let amountOptions = parseEther('0')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let amountOutMin = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])

      await expect(
        uniswapConnector.openFlashLong(optionToken.address, amountOptions, amountOutMin.add(1))
      ).to.be.revertedWith('INSUFFICIENT_OUTPUT_AMOUNT')
    })
  })

  describe('closeFlashLong()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, uniswapConnector.address, uniswapRouter.address],
        [optionToken, redeemToken],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 950
      const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
      await trader.safeMint(optionToken.address, totalOptions.add(parseEther('10')), Alice)

      // Add liquidity to redeem <> weth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        weth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )

      let pair = new ethers.Contract(
        await uniswapFactory.getPair(underlyingToken.address, redeemToken.address),
        UniswapV2Pair.abi,
        Admin
      )
      reserves = await pair.getReserves()
      reserve0 = reserves._reserve0
      reserve1 = reserves._reserve1
    })

    it('should revert on flash close because it would cost the user a negative payout', async () => {
      // Get the pair instance to approve it to the uniswapConnector
      let amountRedeems = parseEther('0.1')
      await expect(uniswapConnector.closeFlashLong(optionToken.address, amountRedeems, '1')).to.be.revertedWith(
        'ERR_UNISWAPV2_CALL_FAIL'
      )
    })

    it('should flash close a long position at the expense of the user', async () => {
      // Get the pair instance to approve it to the uniswapConnector
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let quoteBalanceBefore = await quoteToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      let amountRedeems = parseEther('0.01')
      await expect(uniswapConnector.closeFlashLong(optionToken.address, amountRedeems, '0')).to.emit(
        uniswapConnector,
        'FlashClosed'
      )

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let quoteBalanceAfter = await quoteToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(Alice)
      let optionBalanceAfter = await optionToken.balanceOf(Alice)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore)
      // Purchased quoteTokens with our options (Alice)
      let quoteChange = quoteBalanceAfter.sub(quoteBalanceBefore)
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let optionChange = optionBalanceAfter.sub(optionBalanceBefore)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore)

      assert.equal(underlyingChange.toString() <= '0', true, `${formatEther(underlyingChange)}`)
      assertBNEqual(optionChange.toString(), amountRedeems.mul(base).div(quote).mul(-1))
      assertBNEqual(quoteChange.toString(), '0')
      assertBNEqual(redeemChange.toString(), '0')
    })
  })

  describe('negative Premium handling()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, uniswapConnector.address, uniswapRouter.address],
        [optionToken, redeemToken],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 950
      const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
      await trader.safeMint(optionToken.address, totalOptions.add(parseEther('10')), Alice)

      // Add liquidity to redeem <> weth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        weth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )

      let pair = new ethers.Contract(
        await uniswapFactory.getPair(underlyingToken.address, redeemToken.address),
        UniswapV2Pair.abi,
        Admin
      )
      reserves = await pair.getReserves()
      reserve0 = reserves._reserve0
      reserve1 = reserves._reserve1
    })

    it('returns a loanRemainder amount of 0 in the event FlashOpened because negative premium', async () => {
      // Get the pair instance to approve it to the uniswapConnector
      let amountOptions = parseEther('0.01')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let amountOutMin = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])
      amountOutMin = amountOutMin.gt(0) ? amountOutMin : parseEther('0')
      await expect(uniswapConnector.openFlashLong(optionToken.address, amountOptions, amountOutMin))
        .to.emit(uniswapConnector, 'FlashOpened')
        .withArgs(uniswapConnector.address, amountOptions, '0')
    })
  })
})
